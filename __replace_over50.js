require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const Product = require('./models/tracker/Product');
  const { endListing } = require('./jobs/ebayPriceSync');
  const { deleteCloudinaryFolder } = require('./utils/cloudinaryUtils');

  const over50 = await Product.find(
    { current: { $gte: 50 } },
    'title current ebayListingId cloudinaryFolder'
  ).lean();

  console.log(`\nFound ${over50.length} products with Amazon price >= $50\n`);
  over50.forEach(p => console.log(`  $${p.current?.toFixed(2)} | ${p.ebayListingId || 'no eBay'} | ${p.title?.slice(0,70)}`));

  // Group eBay-listed ones by listingId to end them
  const withEbay = over50.filter(p => p.ebayListingId);
  const ebayGroups = {};
  for (const p of withEbay) {
    if (!ebayGroups[p.ebayListingId]) ebayGroups[p.ebayListingId] = [];
    ebayGroups[p.ebayListingId].push(p);
  }

  for (const [listingId, variants] of Object.entries(ebayGroups)) {
    try {
      await endListing(listingId);
      console.log(`\n✓ Ended eBay listing ${listingId}`);
    } catch (e) {
      console.log(`\n⚠ Could not end eBay listing ${listingId}: ${e.message}`);
    }
  }

  // Delete all over-$50 products from DB
  const ids = over50.map(p => p._id);
  await Product.deleteMany({ _id: { $in: ids } });
  console.log(`\n✓ Deleted ${over50.length} products from DB`);

  // Clean up Cloudinary folders
  const folders = [...new Set(over50.map(p => p.cloudinaryFolder).filter(Boolean))];
  for (const folder of folders) {
    await deleteCloudinaryFolder(folder).catch(e => console.log(`  ⚠ Cloudinary ${folder}: ${e.message}`));
    console.log(`  ✓ Deleted Cloudinary folder: ${folder}`);
  }

  console.log(`\nRunning product discovery for ${over50.length} replacement slots...\n`);
  const { runProductDiscovery } = require('./jobs/productDiscovery');
  await runProductDiscovery(null, over50.length);

  console.log('\nAll done.');
  await mongoose.disconnect();
}).catch(e => { console.error(e.message); process.exit(1); });
