/**
 * migrateCloudinaryToB2.js — copy tracker images from Cloudinary URLs → Backblaze B2
 *
 * Finds every Product whose `images` array contains a Cloudinary URL, downloads
 * each image, uploads it to B2 under the same tracker-images/<slug>/ key pattern
 * the app uses, then updates image / images / cloudinaryFolder in MongoDB.
 *
 * Usage:
 *   node scripts/migrateCloudinaryToB2.js            # live migration
 *   node scripts/migrateCloudinaryToB2.js --dry-run  # preview only, no uploads/DB writes
 *   node scripts/migrateCloudinaryToB2.js --delete   # also delete Cloudinary files after migration
 *
 * Resumable: a .migrate-state.json file records successfully migrated product IDs
 * so re-running the script skips already-done products.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios     = require('axios');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const mongoose  = require('mongoose');
const { v2: cloudinary } = require('cloudinary');

const DRY_RUN    = process.argv.includes('--dry-run');
const DELETE_OLD = process.argv.includes('--delete');
const STATE_FILE = path.join(__dirname, '.migrate-state.json');

// ── B2 helpers (inline — avoids require path issues when run standalone) ──────

let _b2Auth = null;

async function b2Auth() {
  if (_b2Auth && Date.now() < _b2Auth.expiresAt) return _b2Auth;
  const cred = Buffer.from(`${process.env.B2_KEY_ID}:${process.env.B2_APP_KEY}`).toString('base64');
  const { data } = await axios.get('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: `Basic ${cred}` },
    timeout: 10000,
  });
  _b2Auth = {
    apiUrl:      data.apiInfo.storageApi.apiUrl,
    authToken:   data.authorizationToken,
    downloadUrl: data.apiInfo.storageApi.downloadUrl,
    bucketId:    data.apiInfo.storageApi.bucketId,
    expiresAt:   Date.now() + 23 * 3600 * 1000,
  };
  return _b2Auth;
}

function b2PublicUrl(fileKey) {
  const bucket = process.env.B2_BUCKET;
  const base   = (_b2Auth?.downloadUrl) || 'https://f004.backblazeb2.com';
  return `${base}/file/${bucket}/${fileKey}`;
}

async function listB2Files(prefix) {
  const b2 = await b2Auth();
  const { data } = await axios.post(`${b2.apiUrl}/b2api/v3/b2_list_file_names`,
    { bucketId: b2.bucketId, prefix, maxFileCount: 50 },
    { headers: { Authorization: b2.authToken }, timeout: 10000 }
  );
  return (data.files || []).map(f => ({ key: f.fileName, url: b2PublicUrl(f.fileName) }));
}

async function uploadToB2(buffer, fileKey, contentType = 'image/jpeg') {
  const b2 = await b2Auth();
  const { data: upData } = await axios.post(`${b2.apiUrl}/b2api/v3/b2_get_upload_url`,
    { bucketId: b2.bucketId },
    { headers: { Authorization: b2.authToken }, timeout: 10000 }
  );
  const sha1       = crypto.createHash('sha1').update(buffer).digest('hex');
  const encodedKey = fileKey.split('/').map(encodeURIComponent).join('/');
  await axios.post(upData.uploadUrl, buffer, {
    headers: {
      Authorization:       upData.authorizationToken,
      'X-Bz-File-Name':    encodedKey,
      'Content-Type':      contentType,
      'Content-Length':    buffer.length,
      'X-Bz-Content-Sha1': sha1,
    },
    maxBodyLength: 20 * 1024 * 1024,
    timeout: 30000,
  });
  return b2PublicUrl(fileKey);
}

// ── Cloudinary helpers ────────────────────────────────────────────────────────

function isCloudinaryUrl(url) {
  return typeof url === 'string' && (url.includes('res.cloudinary.com') || url.includes('.cloudinary.com'));
}

async function deleteCloudinaryFolder(folder) {
  try {
    await cloudinary.api.delete_resources_by_prefix(folder + '/', { invalidate: true });
    await cloudinary.api.delete_folder(folder).catch(() => {});
    console.log(`    cloudinary: deleted ${folder}`);
  } catch (e) {
    console.log(`    cloudinary: delete failed for ${folder}: ${e.message || e}`);
  }
}

// ── State (resume support) ────────────────────────────────────────────────────

function loadState() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).done); }
  catch { return new Set(); }
}

function saveState(done) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ done: [...done] }, null, 2));
}

// ── Slug formula — must match fetchAndUploadImages in routes/tracker/index.js ──

function productSlug(product) {
  const asin = product.url?.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || product._id.toString();
  return `${product._id}-${asin}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) console.log('--- DRY RUN — no uploads or DB writes ---\n');

  if (!process.env.B2_KEY_ID || !process.env.B2_APP_KEY || !process.env.B2_BUCKET) {
    console.error('B2 credentials missing. Check B2_KEY_ID, B2_APP_KEY, B2_BUCKET in .env');
    process.exit(1);
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  await mongoose.connect(process.env.MONGO_URI);
  const Product = require('../models/tracker/Product');

  // Find products that still have at least one Cloudinary image URL
  const allProducts = await Product.find(
    {},
    '_id url title image images cloudinaryFolder'
  ).lean();

  const toMigrate = allProducts.filter(p =>
    p.images?.some(isCloudinaryUrl) || isCloudinaryUrl(p.image)
  );

  console.log(`Total products:     ${allProducts.length}`);
  console.log(`Need migration:     ${toMigrate.length}`);

  if (!toMigrate.length) {
    console.log('\nAll products already use B2 (or have no images). Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  // Verify B2 auth works before starting
  try {
    await b2Auth();
    console.log(`B2 bucket:          ${process.env.B2_BUCKET}\n`);
  } catch (e) {
    console.error('B2 auth failed:', e.message);
    await mongoose.disconnect();
    process.exit(1);
  }

  const done = loadState();
  const pending = toMigrate.filter(p => !done.has(p._id.toString()));
  if (done.size > 0) console.log(`Already done:       ${done.size} — resuming with ${pending.length} remaining\n`);

  let migrated = 0, skipped = 0, failed = 0;
  const startTime = Date.now();

  for (let i = 0; i < pending.length; i++) {
    const product = pending[i];
    const id      = product._id.toString();
    const slug    = productSlug(product);
    const folder  = `tracker-images/${slug}`;
    const pct     = Math.round(((done.size + i + 1) / toMigrate.length) * 100);

    console.log(`[${done.size + i + 1}/${toMigrate.length}] ${pct}% — ${product.title?.slice(0, 60) || id}`);
    console.log(`    ID: ${id}  folder: ${folder}`);

    const cloudinaryImages = (product.images || []).filter(isCloudinaryUrl);
    console.log(`    Cloudinary images: ${cloudinaryImages.length}`);

    // Check what's already in B2
    let existingB2 = [];
    try {
      existingB2 = await listB2Files(folder + '/');
    } catch {}

    if (existingB2.length >= cloudinaryImages.length && existingB2.length > 0) {
      console.log(`    B2 already has ${existingB2.length} images — updating DB and skipping upload`);
      if (!DRY_RUN) {
        const urls = existingB2.map(f => f.url);
        await Product.findByIdAndUpdate(id, {
          image: urls[0],
          images: urls,
          cloudinaryFolder: folder,
        });
        done.add(id);
        saveState(done);
      }
      skipped++;
      continue;
    }

    // Download from Cloudinary and upload to B2
    const b2Urls = existingB2.map(f => f.url);
    const startIndex = existingB2.length;
    let uploadFailed = false;

    for (let j = startIndex; j < cloudinaryImages.length; j++) {
      const srcUrl = cloudinaryImages[j];
      const fileKey = `${folder}/${slug}-${String(j + 1).padStart(2, '0')}.jpg`;
      process.stdout.write(`    [${j + 1}/${cloudinaryImages.length}] downloading … `);

      try {
        const { data: imgBuffer } = await axios.get(srcUrl, {
          responseType: 'arraybuffer',
          timeout: 20000,
        });
        const buf = Buffer.from(imgBuffer);

        if (buf.length < 500) {
          console.log(`skipped (too small: ${buf.length}b)`);
          continue;
        }
        if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
          console.log('skipped (GIF placeholder)');
          continue;
        }

        process.stdout.write(`${buf.length}b → B2 … `);

        if (!DRY_RUN) {
          const b2Url = await uploadToB2(buf, fileKey);
          b2Urls.push(b2Url);
          console.log('ok');
        } else {
          console.log('(dry-run)');
          b2Urls.push(`[DRY_RUN] ${fileKey}`);
        }
      } catch (e) {
        console.log(`FAILED: ${e.message}`);
        uploadFailed = true;
      }
    }

    if (!b2Urls.length) {
      console.log(`    No images uploaded — skipping DB update`);
      failed++;
      continue;
    }

    if (!DRY_RUN) {
      await Product.findByIdAndUpdate(id, {
        image: b2Urls[0],
        images: b2Urls,
        cloudinaryFolder: folder,
      });
      console.log(`    DB updated with ${b2Urls.length} B2 URL(s)`);

      if (DELETE_OLD && product.cloudinaryFolder && !uploadFailed) {
        await deleteCloudinaryFolder(product.cloudinaryFolder);
      }

      done.add(id);
      saveState(done);
    } else {
      console.log(`    (dry-run) would update DB with ${b2Urls.length} URL(s)`);
    }

    migrated++;

    // Small delay to avoid hammering B2
    if (i < pending.length - 1) await new Promise(r => setTimeout(r, 300));
  }

  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone in ${totalSec}s.`);
  console.log(`  Migrated:  ${migrated}`);
  console.log(`  Skipped (already in B2): ${skipped}`);
  if (failed) console.log(`  Failed:    ${failed} (re-run to retry)`);

  if (!DRY_RUN && !failed) {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
