/**
 * rescrapeFailedImages.js — Re-fetch Amazon images for products whose Cloudinary
 * images were lost (404) and upload them to B2.
 *
 * Usage:
 *   node scripts/rescrapeFailedImages.js            # live run
 *   node scripts/rescrapeFailedImages.js --dry-run  # preview only
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios    = require('axios');
const crypto   = require('crypto');
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');

// ── B2 helpers (same as b2Utils.js) ──────────────────────────────────────────

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

// ── ScraperAPI autoparse ───────────────────────────────────────────────────────

async function scraperApiAutoparse(amazonUrl) {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) return null;
  try {
    const { data } = await axios.get('http://api.scraperapi.com/', {
      params: { api_key: key, url: amazonUrl, autoparse: 'true' },
      timeout: 60000,
    });
    if (data && (data.name || data.images)) return data;
    return null;
  } catch (e) {
    console.warn(`  scraperapi failed: ${e.message}`);
    return null;
  }
}

// ── Amazon image extraction (legacy ASIN probe fallback) ─────────────────────

async function probeLegacyAsinImages(asin) {
  const base = `https://images-na.ssl-images-amazon.com/images/P/${asin}`;
  const getSize = async (url) => {
    try {
      const r = await axios.head(url, { timeout: 5000 });
      return parseInt(r.headers['content-length'] || '0', 10);
    } catch { return 0; }
  };
  const size01 = await getSize(`${base}.01.LZZZZZZZ.jpg`);
  if (!size01) return [];
  const urls = [`${base}.01.LZZZZZZZ.jpg`];
  const checks = await Promise.all(
    Array.from({ length: 11 }, (_, i) => {
      const idx = String(i + 2).padStart(2, '0');
      const url = `${base}.${idx}.LZZZZZZZ.jpg`;
      return getSize(url).then(sz => sz > 0 && sz !== size01 ? url : null);
    })
  );
  urls.push(...checks.filter(Boolean));
  return urls;
}

// ── Upload images to B2 ───────────────────────────────────────────────────────

async function uploadImagesTob2(product, imageUrls, folder, slug) {
  const b2Urls = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const src    = imageUrls[i];
    const fileKey = `${folder}/${slug}-${String(i + 1).padStart(2, '0')}.jpg`;
    process.stdout.write(`    [${i + 1}/${imageUrls.length}] downloading … `);
    try {
      // Try full-res first, fall back to original URL
      const fullRes = src.replace(/\._[A-Z0-9_]+_(?=\.jpg)/i, '');
      let imgBuffer;
      try {
        ({ data: imgBuffer } = await axios.get(fullRes, { responseType: 'arraybuffer', timeout: 15000 }));
      } catch {
        ({ data: imgBuffer } = await axios.get(src, { responseType: 'arraybuffer', timeout: 15000 }));
      }
      const buf = Buffer.from(imgBuffer);
      if (buf.length < 500 || (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)) {
        console.log(`skipped (GIF/tiny ${buf.length}b)`);
        continue;
      }
      process.stdout.write(`${buf.length}b → B2 … `);
      if (!DRY_RUN) {
        const url = await uploadToB2(buf, fileKey);
        b2Urls.push(url);
        console.log('ok');
      } else {
        console.log('(dry-run)');
        b2Urls.push(`[DRY_RUN] ${fileKey}`);
      }
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }
  return b2Urls;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) console.log('--- DRY RUN — no uploads or DB writes ---\n');

  if (!process.env.B2_KEY_ID || !process.env.B2_APP_KEY || !process.env.B2_BUCKET) {
    console.error('B2 credentials missing in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const Product = require('../models/tracker/Product');

  // Find products still with Cloudinary URLs
  const failed = await Product.find(
    {},
    '_id url title image images cloudinaryFolder variant'
  ).lean().then(all =>
    all.filter(p =>
      p.images?.some(u => u.includes('res.cloudinary.com') || u.includes('.cloudinary.com'))
      || (typeof p.image === 'string' && p.image.includes('cloudinary'))
    )
  );

  console.log(`Products needing re-scrape: ${failed.length}\n`);
  if (!failed.length) {
    console.log('Nothing to do — all products already have B2 images.');
    await mongoose.disconnect();
    return;
  }

  // Verify B2 auth
  try {
    await b2Auth();
    console.log(`B2 bucket: ${process.env.B2_BUCKET}\n`);
  } catch (e) {
    console.error('B2 auth failed:', e.message);
    await mongoose.disconnect();
    process.exit(1);
  }

  let migrated = 0, failed_count = 0;

  for (let i = 0; i < failed.length; i++) {
    const product = failed[i];
    const id      = product._id.toString();
    const asin    = product.url?.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || id;
    const slug    = `${id}-${asin}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
    const folder  = `tracker-images/${slug}`;
    const pct     = Math.round(((i + 1) / failed.length) * 100);

    console.log(`[${i + 1}/${failed.length}] ${pct}% — ${product.title?.slice(0, 60) || id}`);
    console.log(`    ASIN: ${asin}  folder: ${folder}`);

    let amazonImages = [];

    // ── Path 1: ScraperAPI autoparse ────────────────────────────────────────
    if (!amazonImages.length) {
      process.stdout.write('    ScraperAPI autoparse … ');
      const parsed = await scraperApiAutoparse(product.url);
      if (parsed) {
        const forceHiRes = u => String(u).replace(/\._AC_(?:US\d+|SX\d+|SY\d+|SS\d+)?_?(?=\.jpg)/i, '._AC_SL1500_');
        const hiRes = (parsed.highResImages || [])
          .map(img => forceHiRes(typeof img === 'string' ? img : (img.link || img.url || '')))
          .filter(u => u.includes('media-amazon') || u.includes('ssl-images-amazon'));

        const selectedVariant = (parsed.customization_options?.Color || []).find(c => c.is_selected);
        const swatch = selectedVariant?.image ? forceHiRes(selectedVariant.image) : null;

        // Try to match variant swatch if product has a variant
        if (product.variant && parsed.customization_options?.Color?.length) {
          const norm = product.variant.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
          const match = parsed.customization_options.Color.find(c => {
            const cv = (c.value || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
            return cv === norm || cv.includes(norm) || norm.includes(cv);
          });
          if (match?.image) amazonImages = [forceHiRes(match.image), ...hiRes];
        }
        if (!amazonImages.length) {
          amazonImages = swatch ? [swatch, ...hiRes] : hiRes;
        }
        console.log(`got ${amazonImages.length} images`);
      } else {
        console.log('no result');
      }
    }

    // ── Path 2: Legacy ASIN image probe ────────────────────────────────────
    if (!amazonImages.length) {
      process.stdout.write('    Legacy ASIN probe … ');
      const probed = await probeLegacyAsinImages(asin);
      if (probed.length) {
        amazonImages = probed;
        console.log(`got ${amazonImages.length} images`);
      } else {
        console.log('no images found');
      }
    }

    if (!amazonImages.length) {
      console.log('    No images found — skipping\n');
      failed_count++;
      continue;
    }

    // ── Upload to B2 ────────────────────────────────────────────────────────
    const b2Urls = await uploadImagesTob2(product, amazonImages, folder, slug);

    if (!b2Urls.length) {
      console.log('    All uploads failed\n');
      failed_count++;
      continue;
    }

    if (!DRY_RUN) {
      await Product.findByIdAndUpdate(id, {
        image: b2Urls[0],
        images: b2Urls,
        cloudinaryFolder: folder,
      });
      console.log(`    DB updated with ${b2Urls.length} B2 URL(s)\n`);
    } else {
      console.log(`    (dry-run) would update DB with ${b2Urls.length} URL(s)\n`);
    }

    migrated++;

    // Small delay between products to avoid hammering ScraperAPI
    if (i < failed.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone.`);
  console.log(`  Re-scraped & uploaded: ${migrated}`);
  if (failed_count) console.log(`  Still failed:          ${failed_count}`);

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
