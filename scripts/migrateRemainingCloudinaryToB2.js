/**
 * migrateRemainingCloudinaryToB2.js — copy the last non-tracker Cloudinary images to B2
 *
 * Covers: AbtStaff.image, AbtAnnouncement.image/fileUrl, ContactReport.imageUrl,
 * Recipe.image + ingredients[].image, Catalog.photo.main/thumbnail, productportal
 * Product.imageUrl, AbtNews.image/images, AbtContactMessage.images, AbtBanner.imageUrl,
 * AbtTravel.image/images, AbtSettings.value, Ingredient.image, and AbtPage's nested
 * pdf/image blocks.
 *
 * Usage:
 *   node scripts/migrateRemainingCloudinaryToB2.js            # live migration
 *   node scripts/migrateRemainingCloudinaryToB2.js --dry-run  # preview only
 *
 * Resumable: a .migrate-remaining-state.json file records successfully migrated
 * "<collection>:<id>:<field>" keys so re-running skips already-done ones. Only
 * touches fields whose current value is a Cloudinary URL — safe to re-run.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');
const { uploadToB2 } = require('../utils/b2Utils');

const DRY_RUN = process.argv.includes('--dry-run');
const STATE_FILE = path.join(__dirname, '.migrate-remaining-state.json');

const AbtStaff = require('../models/abt/AbtStaff');
const AbtAnnouncement = require('../models/abt/AbtAnnouncement');
const ContactReport = require('../models/accounting/ContactReport');
const Recipe = require('../models/recipe/Recipe');
const Catalog = require('../models/inventory/Catalog');
const PortalProduct = require('../models/productportal/Product');
const AbtNews = require('../models/abt/AbtNews');
const AbtContactMessage = require('../models/abt/AbtContactMessage');
const AbtBanner = require('../models/abt/AbtBanner');
const AbtTravel = require('../models/abt/AbtTravel');
const AbtSettings = require('../models/abt/AbtSettings');
const AbtPage = require('../models/abt/AbtPage');
const Ingredient = require('../models/recipe/Ingredient');
const AbtProduct = require('../models/abt/AbtProduct');

function loadState() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch { return new Set(); }
}
function saveState(done) {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...done]));
}

function isCloudinaryUrl(url) {
  return typeof url === 'string' && /res\.cloudinary\.com|api\.cloudinary\.com/.test(url);
}

async function migrateUrl(url, folder, forcedContentType = null) {
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  const buffer = Buffer.from(data);
  const isPdf = forcedContentType === 'application/pdf';
  let name = decodeURIComponent(url.split('/').pop().split('?')[0]) || `${Date.now()}.jpg`;
  if (isPdf && !/\.pdf$/i.test(name)) name += '.pdf';
  const contentType = forcedContentType
    || (/\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg');
  const key = `${folder}/${Date.now()}-${name}`;
  return uploadToB2(buffer, key, contentType);
}

// `doc` is whatever mongoose (sub)document actually owns `field` (e.g. the ingredient
// subdocument itself, not the parent Recipe) — `stateKey` uniquely identifies this
// field across the whole migration for the resumable-state file. Caller is responsible
// for calling `.save()` on the top-level document afterward (subdocuments can't save themselves).
async function migrateField({ doc, field, folder, stateKey, done, counts, save = true, contentType = null }) {
  const value = doc.get(field);
  if (!isCloudinaryUrl(value) || done.has(stateKey)) return;

  counts.found++;
  console.log(`${DRY_RUN ? '[dry-run] would migrate' : 'migrating'} ${stateKey}`);
  if (DRY_RUN) return;

  try {
    const newUrl = await migrateUrl(value, folder, contentType);
    doc.set(field, newUrl);
    // Skip validation — we're only touching the image field, and some legacy documents
    // have unrelated fields (e.g. Catalog.category/type) that predate current enum constraints.
    if (save) await doc.save({ validateBeforeSave: false });
    done.add(stateKey);
    counts.migrated++;
  } catch (e) {
    console.error(`  failed: ${e.message}`);
    counts.failed++;
  }
}

// For plain string-array fields like `images: [String]` — migrates each Cloudinary
// URL in place and lets the caller save the parent document once afterward.
async function migrateArrayField({ doc, field, folder, stateKeyPrefix, done, counts }) {
  const arr = doc.get(field) || [];
  let dirty = false;
  for (let i = 0; i < arr.length; i++) {
    const stateKey = `${stateKeyPrefix}:${i}`;
    if (!isCloudinaryUrl(arr[i]) || done.has(stateKey)) continue;
    counts.found++;
    console.log(`${DRY_RUN ? '[dry-run] would migrate' : 'migrating'} ${stateKey}`);
    if (DRY_RUN) continue;
    try {
      arr[i] = await migrateUrl(arr[i], folder);
      done.add(stateKey);
      counts.migrated++;
      dirty = true;
    } catch (e) {
      console.error(`  failed: ${e.message}`);
      counts.failed++;
    }
  }
  if (dirty) doc.set(field, arr);
  return dirty;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const done = loadState();
  const counts = { found: 0, migrated: 0, failed: 0 };

  for (const staff of await AbtStaff.find()) {
    await migrateField({ doc: staff, field: 'image', folder: 'abt-images', stateKey: `AbtStaff:${staff._id}:image`, done, counts });
  }

  for (const ann of await AbtAnnouncement.find()) {
    await migrateField({ doc: ann, field: 'image', folder: 'abt-images', stateKey: `AbtAnnouncement:${ann._id}:image`, done, counts });
    await migrateField({ doc: ann, field: 'fileUrl', folder: 'abt-images', stateKey: `AbtAnnouncement:${ann._id}:fileUrl`, done, counts });
  }

  for (const report of await ContactReport.find()) {
    await migrateField({ doc: report, field: 'imageUrl', folder: 'contact-images', stateKey: `ContactReport:${report._id}:imageUrl`, done, counts });
  }

  for (const recipe of await Recipe.find()) {
    let dirty = false;
    if (isCloudinaryUrl(recipe.image)) {
      await migrateField({ doc: recipe, field: 'image', folder: 'recipe-images', stateKey: `Recipe:${recipe._id}:image`, done, counts, save: false });
      dirty = true;
    }
    for (let i = 0; i < recipe.ingredients.length; i++) {
      if (isCloudinaryUrl(recipe.ingredients[i].image)) {
        await migrateField({ doc: recipe.ingredients[i], field: 'image', folder: 'recipe-images', stateKey: `Recipe:${recipe._id}:ingredients.${i}.image`, done, counts, save: false });
        dirty = true;
      }
    }
    if (dirty && !DRY_RUN) await recipe.save({ validateBeforeSave: false });
  }

  for (const item of await Catalog.find()) {
    await migrateField({ doc: item, field: 'photo.main', folder: 'productportal-images', stateKey: `Catalog:${item._id}:photo.main`, done, counts });
    await migrateField({ doc: item, field: 'photo.thumbnail', folder: 'productportal-images', stateKey: `Catalog:${item._id}:photo.thumbnail`, done, counts });
  }

  for (const p of await PortalProduct.find()) {
    await migrateField({ doc: p, field: 'imageUrl', folder: 'productportal-images', stateKey: `Product:${p._id}:imageUrl`, done, counts });
  }

  for (const news of await AbtNews.find()) {
    let dirty = false;
    if (isCloudinaryUrl(news.image)) { await migrateField({ doc: news, field: 'image', folder: 'abt-images', stateKey: `AbtNews:${news._id}:image`, done, counts, save: false }); dirty = true; }
    if (await migrateArrayField({ doc: news, field: 'images', folder: 'abt-images', stateKeyPrefix: `AbtNews:${news._id}:images`, done, counts })) dirty = true;
    if (dirty && !DRY_RUN) await news.save({ validateBeforeSave: false });
  }

  for (const msg of await AbtContactMessage.find()) {
    if (await migrateArrayField({ doc: msg, field: 'images', folder: 'abt-images', stateKeyPrefix: `AbtContactMessage:${msg._id}:images`, done, counts })) {
      if (!DRY_RUN) await msg.save({ validateBeforeSave: false });
    }
  }

  for (const banner of await AbtBanner.find()) {
    await migrateField({ doc: banner, field: 'imageUrl', folder: 'abt-images', stateKey: `AbtBanner:${banner._id}:imageUrl`, done, counts });
  }

  for (const travel of await AbtTravel.find()) {
    let dirty = false;
    if (isCloudinaryUrl(travel.image)) { await migrateField({ doc: travel, field: 'image', folder: 'abt-images', stateKey: `AbtTravel:${travel._id}:image`, done, counts, save: false }); dirty = true; }
    if (await migrateArrayField({ doc: travel, field: 'images', folder: 'abt-images', stateKeyPrefix: `AbtTravel:${travel._id}:images`, done, counts })) dirty = true;
    if (dirty && !DRY_RUN) await travel.save({ validateBeforeSave: false });
  }

  for (const setting of await AbtSettings.find()) {
    if (typeof setting.value === 'string') {
      await migrateField({ doc: setting, field: 'value', folder: 'abt-images', stateKey: `AbtSettings:${setting._id}:value`, done, counts });
    }
  }

  for (const ing of await Ingredient.find()) {
    await migrateField({ doc: ing, field: 'image', folder: 'recipe-images', stateKey: `Ingredient:${ing._id}:image`, done, counts });
  }

  for (const prod of await AbtProduct.find()) {
    let dirty = false;
    if (isCloudinaryUrl(prod.image)) { await migrateField({ doc: prod, field: 'image', folder: 'abt-images', stateKey: `AbtProduct:${prod._id}:image`, done, counts, save: false }); dirty = true; }
    if (await migrateArrayField({ doc: prod, field: 'images', folder: 'abt-images', stateKeyPrefix: `AbtProduct:${prod._id}:images`, done, counts })) dirty = true;
    if (dirty && !DRY_RUN) await prod.save({ validateBeforeSave: false });
  }

  // AbtPage: image URLs live inside schemaless `blocks[].data` — pdf blocks store a
  // single `data.url` (Cloudinary raw resource, no file extension in the URL itself,
  // so force application/pdf), image blocks store `data.images[].url`.
  for (const page of await AbtPage.find()) {
    let dirty = false;
    const blocks = page.blocks || [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type === 'pdf' && isCloudinaryUrl(block.data?.url)) {
        const stateKey = `AbtPage:${page._id}:blocks.${i}.data.url`;
        if (!done.has(stateKey)) {
          counts.found++;
          console.log(`${DRY_RUN ? '[dry-run] would migrate' : 'migrating'} ${stateKey}`);
          if (!DRY_RUN) {
            try {
              block.data.url = await migrateUrl(block.data.url, 'abt-images', 'application/pdf');
              done.add(stateKey);
              counts.migrated++;
              dirty = true;
            } catch (e) {
              console.error(`  failed: ${e.message}`);
              counts.failed++;
            }
          }
        }
      } else if (block.type === 'image' && Array.isArray(block.data?.images)) {
        for (let j = 0; j < block.data.images.length; j++) {
          const img = block.data.images[j];
          const stateKey = `AbtPage:${page._id}:blocks.${i}.data.images.${j}.url`;
          if (!isCloudinaryUrl(img?.url) || done.has(stateKey)) continue;
          counts.found++;
          console.log(`${DRY_RUN ? '[dry-run] would migrate' : 'migrating'} ${stateKey}`);
          if (DRY_RUN) continue;
          try {
            img.url = await migrateUrl(img.url, 'abt-images');
            done.add(stateKey);
            counts.migrated++;
            dirty = true;
          } catch (e) {
            console.error(`  failed: ${e.message}`);
            counts.failed++;
          }
        }
      }
    }
    if (dirty && !DRY_RUN) {
      page.markModified('blocks');
      await page.save({ validateBeforeSave: false });
    }
  }

  if (!DRY_RUN) saveState(done);
  console.log(`\nDone. Found ${counts.found} Cloudinary URLs, migrated ${counts.migrated}, failed ${counts.failed}.`);
  await mongoose.disconnect();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
