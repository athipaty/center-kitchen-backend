/**
 * Deletes Cloudinary folders under ebay-listings/ that are not referenced
 * by any product in the database.
 *
 * Run: node scripts/cleanupCloudinary.js
 * Add --dry-run to preview without deleting.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { v2: cloudinary } = require('cloudinary');
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function listAllSubfolders() {
  // Cloudinary paginates folders — gather all pages
  const folders = [];
  let nextCursor;
  do {
    const res = await cloudinary.api.sub_folders('ebay-listings', {
      max_results: 500,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    });
    folders.push(...(res.folders || []));
    nextCursor = res.next_cursor;
  } while (nextCursor);
  return folders.map(f => f.path);
}

async function deleteFolder(folder) {
  await cloudinary.api.delete_resources_by_prefix(folder + '/', { invalidate: true });
  await cloudinary.api.delete_folder(folder).catch(() => {});
}

async function main() {
  if (DRY_RUN) console.log('--- DRY RUN — nothing will be deleted ---\n');

  await mongoose.connect(process.env.MONGO_URI);
  const Product = require('../models/tracker/Product');

  const docs = await Product.find({ cloudinaryFolder: { $ne: null } }, 'cloudinaryFolder title ebayListingId').lean();
  const usedFolders = new Set(docs.map(d => d.cloudinaryFolder));
  console.log(`DB: ${usedFolders.size} folder(s) in use across ${docs.length} product(s)`);

  let cloudFolders;
  try {
    cloudFolders = await listAllSubfolders();
  } catch (e) {
    console.error('Failed to list Cloudinary folders:', e.message || e);
    process.exit(1);
  }
  console.log(`Cloudinary: ${cloudFolders.length} folder(s) found under ebay-listings/\n`);

  const unused = cloudFolders.filter(f => !usedFolders.has(f));
  const inUse  = cloudFolders.filter(f =>  usedFolders.has(f));

  console.log(`In use (keeping ${inUse.length}):`);
  inUse.forEach(f => {
    const product = docs.find(d => d.cloudinaryFolder === f);
    console.log(`  ✓ ${f}  →  eBay: ${product?.ebayListingId || 'no listing'}`);
  });

  console.log(`\nUnused (${unused.length}) — will be deleted:`);
  if (!unused.length) {
    console.log('  (none — Cloudinary is already clean)');
  } else {
    unused.forEach(f => console.log(`  ✗ ${f}`));
  }

  if (!unused.length || DRY_RUN) {
    await mongoose.disconnect();
    return;
  }

  console.log('\nDeleting...');
  let deleted = 0;
  for (const folder of unused) {
    try {
      await deleteFolder(folder);
      console.log(`  deleted: ${folder}`);
      deleted++;
    } catch (e) {
      console.error(`  FAILED: ${folder} —`, e.message || e);
    }
  }

  console.log(`\nDone. ${deleted}/${unused.length} unused folder(s) deleted.`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
