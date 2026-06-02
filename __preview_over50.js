require('dotenv').config();
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI).then(async () => {
  const Product = require('./models/tracker/Product');

  // All products over $50
  const over50 = await Product.find(
    { current: { $gte: 50 } },
    'title current ebayListingId'
  ).lean();

  // All products total
  const total = await Product.countDocuments();

  console.log(`\nTotal tracked products: ${total}`);
  console.log(`Products with Amazon price >= $50: ${over50.length}`);
  over50.forEach(p => {
    const ebay = p.ebayListingId ? `eBay:${p.ebayListingId}` : 'no eBay';
    console.log(`  $${p.current?.toFixed(2)} | ${ebay} | ${p.title?.slice(0,70)}`);
  });

  // Also show price distribution
  const under10 = await Product.countDocuments({ current: { $lt: 10 } });
  const under20 = await Product.countDocuments({ current: { $gte: 10, $lt: 20 } });
  const under35 = await Product.countDocuments({ current: { $gte: 20, $lt: 35 } });
  const under50 = await Product.countDocuments({ current: { $gte: 35, $lt: 50 } });
  console.log(`\nPrice distribution:`);
  console.log(`  <$10: ${under10}   $10-20: ${under20}   $20-35: ${under35}   $35-50: ${under50}   $50+: ${over50.length}`);

  await mongoose.disconnect();
}).catch(e => { console.error(e.message); process.exit(1); });
