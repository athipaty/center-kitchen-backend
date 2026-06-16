require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const { getAccessToken } = require('./jobs/ebayPriceSync');

const LISTING_IDS = ['358685051511', '358685511087'];

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const token = await getAccessToken();

  for (const id of LISTING_IDS) {
    const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll',
      `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${id}</ItemID></GetItemRequest>`,
      { headers: {
          'X-EBAY-API-SITEID': '0',
          'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
          'X-EBAY-API-CALL-NAME': 'GetItem',
          'X-EBAY-API-IAF-TOKEN': token,
          'Content-Type': 'text/xml',
        }
      }
    );

    const title   = xml.match(/<Title>([\s\S]*?)<\/Title>/)?.[1]?.trim() || '(not found)';
    const status  = xml.match(/<ListingStatus>([\s\S]*?)<\/ListingStatus>/)?.[1] || '(not found)';
    const errors  = [...xml.matchAll(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/g)].map(m => m[1]).join('; ');

    const varBlocks = [...xml.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)];
    const variations = varBlocks.map(([, b]) => ({
      label: b.match(/<Value>([\s\S]*?)<\/Value>/)?.[1] || '?',
      price: parseFloat(b.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || 0),
      qty:   parseInt(b.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] || 0),
    }));

    const desc = xml.match(/<Description>([\s\S]*?)<\/Description>/)?.[1] || '';
    const asinMatches = [...desc.matchAll(/\/dp\/([A-Z0-9]{10})/g)].map(m => m[1]);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Listing : ${id}`);
    console.log(`Title   : ${title}`);
    console.log(`Status  : ${status}`);
    if (errors) console.log(`Errors  : ${errors}`);
    if (variations.length) {
      console.log(`Variations (${variations.length}):`);
      for (const v of variations) console.log(`  [${v.label}]  $${v.price.toFixed(2)}  qty:${v.qty}`);
    } else {
      const price = parseFloat(xml.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || 0);
      const qty   = parseInt(xml.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] || 0);
      console.log(`Single  : $${price.toFixed(2)}  qty:${qty}`);
    }
    if (asinMatches.length) console.log(`Amazon ASINs in desc: ${[...new Set(asinMatches)].join(', ')}`);
  }
}

main().catch(e => console.error('Error:', e.message)).finally(() => mongoose.disconnect());
