require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const { getAccessToken } = require('./jobs/ebayPriceSync');
const Product = require('./models/tracker/Product');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const token = await getAccessToken();
  const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

  // Fetch all active eBay listings (up to 200)
  const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll',
    `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></ActiveList></GetMyeBaySellingRequest>`,
    { headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' } }
  );

  const activeSection = xml.match(/<ActiveList>([\s\S]*?)<\/ActiveList>/)?.[1] || '';
  const ebayListings = [];
  for (const [, block] of [...activeSection.matchAll(/<Item>([\s\S]*?)<\/Item>/g)]) {
    const itemId = block.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];
    const title  = (block.match(/<Title>([\s\S]*?)<\/Title>/)?.[1] || '?').trim();
    const varBlocks = [...block.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)];
    const price = parseFloat(block.match(/<CurrentPrice[^>]*>([\d.]+)<\/CurrentPrice>/)?.[1] || block.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || 0);
    if (itemId) ebayListings.push({ itemId, title, varCount: varBlocks.length, price });
  }

  // Get all active DB records with an ebayListingId
  const dbProducts = await Product.find({ ebayListingId: { $ne: null }, status: { $ne: 'archived' } }, 'ebayListingId variant title').lean();
  const trackedIds = new Set(dbProducts.map(p => String(p.ebayListingId)));

  console.log(`\n===== eBay listings NOT in tracker (${ebayListings.filter(l => !trackedIds.has(l.itemId)).length} of ${ebayListings.length}) =====\n`);
  let count = 0;
  for (const l of ebayListings) {
    if (!trackedIds.has(l.itemId)) {
      count++;
      const varLabel = l.varCount ? `(${l.varCount} variations)` : `($${l.price.toFixed(2)})`;
      console.log(`  [${l.itemId}] ${varLabel} ${l.title.slice(0, 80)}`);
    }
  }
  if (!count) console.log('  All active eBay listings are tracked ✓');

  console.log(`\n===== Tracker listings with NO active eBay counterpart =====\n`);
  const ebayIds = new Set(ebayListings.map(l => l.itemId));
  const orphanedInDb = dbProducts.filter(p => !ebayIds.has(String(p.ebayListingId)));
  if (orphanedInDb.length) {
    const byListing = {};
    for (const p of orphanedInDb) {
      const id = p.ebayListingId;
      if (!byListing[id]) byListing[id] = [];
      byListing[id].push(p.variant || p.title?.slice(0, 40) || '?');
    }
    for (const [id, variants] of Object.entries(byListing)) {
      console.log(`  [${id}] ${variants.join(', ')}`);
    }
  } else {
    console.log('  None ✓');
  }

  console.log(`\nTracked IDs in DB : ${trackedIds.size}`);
  console.log(`Active on eBay    : ${ebayListings.length}`);
}

main().catch(e => console.error('Error:', e.message)).finally(() => mongoose.disconnect());
