/**
 * migrateRemainingCloudinaryToB2.js — copy the last non-tracker Cloudinary images to B2
 *
 * Covers: AbtStaff.image, AbtAnnouncement.image/fileUrl, ContactReport.imageUrl,
 * Recipe.image + ingredients[].image, Catalog.photo.main/thumbnail.
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

function loadState() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch { return new Set(); }
}
function saveState(done) {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...done]));
}

function isCloudinaryUrl(url) {
  return typeof url === 'string' && /res\.cloudinary\.com|api\.cloudinary\.com/.test(url);
}

async function migrateUrl(url, folder) {
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  const buffer = Buffer.from(data);
  const name = decodeURIComponent(url.split('/').pop().split('?')[0]) || `${Date.now()}.jpg`;
  const contentType = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
  const key = `${folder}/${Date.now()}-${name}`;
  return uploadToB2(buffer, key, contentType);
}

// `doc` is whatever mongoose (sub)document actually owns `field` (e.g. the ingredient
// subdocument itself, not the parent Recipe) — `stateKey` uniquely identifies this
// field across the whole migration for the resumable-state file. Caller is responsible
// for calling `.save()` on the top-level document afterward (subdocuments can't save themselves).
async function migrateField({ doc, field, folder, stateKey, done, counts, save = true }) {
  const value = doc.get(field);
  if (!isCloudinaryUrl(value) || done.has(stateKey)) return;

  counts.found++;
  console.log(`${DRY_RUN ? '[dry-run] would migrate' : 'migrating'} ${stateKey}`);
  if (DRY_RUN) return;

  try {
    const newUrl = await migrateUrl(value, folder);
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

  if (!DRY_RUN) saveState(done);
  console.log(`\nDone. Found ${counts.found} Cloudinary URLs, migrated ${counts.migrated}, failed ${counts.failed}.`);
  await mongoose.disconnect();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
