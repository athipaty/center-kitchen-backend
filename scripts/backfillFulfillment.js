/**
 * backfillFulfillment.js — One-time backfill of shipsFrom/soldBy/isAmazonFulfilled onto
 * already-tracked products, added after these fields were introduced for the Add-product flow.
 * Idempotent: only touches products where isAmazonFulfilled is still null, so it's safe to
 * re-run after a partial run (crash, rate limit) without re-paying for ones already done.
 *
 * Usage:
 *   node scripts/backfillFulfillment.js            # live run
 *   node scripts/backfillFulfillment.js --dry-run  # preview only, no writes, no ScraperAPI calls
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios = require('axios');
const mongoose = require('mongoose');
const Product = require('../models/tracker/Product');

const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = 3000; // matches queueImageUpload's between-scrape pacing (routes/tracker/index.js)

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
    console.warn(`  scraperApiAutoparse failed: ${e.message}`);
    return null;
  }
}

function isAmazonFulfilled(shipsFrom) {
  if (!shipsFrom) return null;
  const words = String(shipsFrom)
    .replace(/ships\s*from/gi, '')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(Boolean);
  if (!words.length) return null;
  return words.every(w => /^amazon(\.com)?$/i.test(w));
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const products = await Product.find({ isAmazonFulfilled: null }).select('_id url title').lean();
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}${products.length} products need a fulfillment lookup\n`);

  let done = 0, amazonFulfilled = 0, merchantShipped = 0, unknown = 0;

  for (const p of products) {
    done++;
    const label = (p.title || p.url).slice(0, 60);
    if (DRY_RUN) {
      console.log(`[${done}/${products.length}] (dry run, skipping) ${label}`);
      continue;
    }

    const parsed = await scraperApiAutoparse(p.url);
    const shipsFrom = parsed?.ships_from || null;
    const soldBy = parsed?.sold_by || null;
    const flag = isAmazonFulfilled(shipsFrom);

    await Product.updateOne({ _id: p._id }, { $set: { shipsFrom, soldBy, isAmazonFulfilled: flag } });

    if (flag === true) amazonFulfilled++;
    else if (flag === false) merchantShipped++;
    else unknown++;

    console.log(`[${done}/${products.length}] ${flag === true ? '⚠️  FBA' : flag === false ? '✓ merchant' : '?  unknown'} — ${label}`);

    if (done < products.length) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone. ${amazonFulfilled} Amazon-fulfilled, ${merchantShipped} merchant-shipped, ${unknown} unknown (lookup failed).`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
