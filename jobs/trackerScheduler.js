const cron = require("node-cron");
const axios = require("axios");
const { fetchProduct } = require("../scraper");
const Product = require("../models/tracker/Product");
const { syncEbayPrice, syncEbayQty, endListing } = require("./ebayPriceSync");

let io = null;

// Adaptive interval based on price stability:
// - Recently changed (last 3 days)  → 3–6h  (watch actively)
// - Unchanged 3–7 days              → 8–14h (moderate)
// - Unchanged 7+ days               → 20–28h (slow — saves ~4× ScraperAPI calls)
function adaptiveInterval(product) {
  const daysSinceChange = product.history?.length >= 2
    ? (Date.now() - new Date(product.history[product.history.length - 1].createdAt || 0)) / 86400000
    : 0;
  if (daysSinceChange >= 7)  return (Math.random() * 8  + 20) * 3600 * 1000; // 20–28h
  if (daysSinceChange >= 3)  return (Math.random() * 6  + 8)  * 3600 * 1000; // 8–14h
  return                            (Math.random() * 3  + 3)  * 3600 * 1000; // 3–6h
}

function nextCheckDate(product) {
  return new Date(Date.now() + adaptiveInterval(product));
}

function errorRetryDate() {
  // 30–90 min for transient errors (failCount < 3) — quick retry without hammering ScraperAPI
  return new Date(Date.now() + (Math.random() * 60 + 30) * 60 * 1000);
}

function slowRetryDate() {
  // 4–8h for persistent unavailable products (failCount >= 3) — saves ScraperAPI credits
  return new Date(Date.now() + (Math.random() * 4 + 4) * 3600 * 1000);
}

async function checkProduct(p) {
  try {
    // Use price-only direct fetch for routine checks — saves ScraperAPI credits.
    // Full scrape (priceOnly=false) only when metadata is missing or on first check.
    const needsFullScrape = !p.title || !p.image || !p.upc || (p.failCount || 0) > 0;
    const info = await fetchProduct(p.url, { priceOnly: !needsFullScrape });
    const oldPrice = p.current;
    const dropped = info.price < oldPrice;
    const previousStatus = p.status; // save before overwriting

    p.current = info.price;
    if (info.price < p.lowest) p.lowest = info.price;
    if (info.image  && !p.image)  p.image  = info.image;
    if (info.images?.length && (!p.images?.length)) p.images = info.images;
    if (info.upc    && !p.upc)    p.upc    = info.upc;
    if (info.isPrime !== null && info.isPrime !== undefined) p.isPrime = info.isPrime;
    if (info.variant) p.variant = info.variant;
    if (info.specs && Object.keys(info.specs).length) p.specs = info.specs;
    if (info.bullets?.length && !p.bullets?.length) p.bullets = info.bullets;
    if (info.price !== oldPrice) {
      p.history.push({ price: info.price });
      if (p.history.length > 200) p.history = p.history.slice(-200);
    }

    // Reset failure tracking on successful fetch
    p.status = 'active';
    p.failCount = 0;
    p.unavailableSince = null;

    if (p.ebayListingId) {
      try {
        await syncEbayPrice(p.ebayListingId, info.price, p.variant);
        // Restore qty if recovering from any non-active status
        if (previousStatus !== 'active') {
          await syncEbayQty(p.ebayListingId, p.variant, 3);
          console.log(`eBay qty restored: listing ${p.ebayListingId} variant="${p.variant}" → 3 (was ${previousStatus})`);
        }
        console.log(`eBay price synced: listing ${p.ebayListingId} variant="${p.variant}" → $${info.price}`);
        if (io) io.emit('tracker:ebay:sync:ok', { productId: String(p._id) });
      } catch (ebayErr) {
        console.error(`eBay price sync failed for listing ${p.ebayListingId}:`, ebayErr.message);
        if (io) io.emit('tracker:ebay:sync:fail', { productId: String(p._id), error: ebayErr.message });
      }
    }
    p.nextCheck = nextCheckDate(p);
    await p.save();

    if (dropped && io) {
      io.emit("tracker:price:drop", { product: p.toObject(), oldPrice });
    }

    return { id: p._id, success: true, dropped, newPrice: info.price, oldPrice };
  } catch (err) {
    p.failCount = (p.failCount || 0) + 1;

    if (err.code === 'OUT_OF_STOCK') {
      p.status = 'out_of_stock';
      p.nextCheck = p.failCount >= 3 ? slowRetryDate() : errorRetryDate();
    } else {
      p.status = p.failCount >= 3 ? 'unavailable' : 'error';
      p.nextCheck = p.failCount >= 3 ? slowRetryDate() : errorRetryDate();
    }
    // Track when product first became unavailable (for auto-end after 7 days)
    if (p.status === 'unavailable' && !p.unavailableSince) {
      p.unavailableSince = new Date();
    }

    // Push qty=0 to eBay so the variant shows as Out of Stock
    if (p.ebayListingId && (p.status === 'out_of_stock' || p.status === 'unavailable')) {
      try {
        await syncEbayQty(p.ebayListingId, p.variant, 0);
        console.log(`eBay qty set to 0: listing ${p.ebayListingId} variant="${p.variant}" (${p.status})`);
      } catch (qtyErr) {
        console.error(`eBay qty sync failed for listing ${p.ebayListingId}:`, qtyErr.message);
      }
    }

    if (io) io.emit('tracker:product:status', { productId: String(p._id), status: p.status, failCount: p.failCount });

    await p.save();
    return { id: p._id, success: false, status: p.status, failCount: p.failCount, error: err.message };
  }
}

const DEAD_LISTING_DAYS = 7;

async function checkDeadListings() {
  const cutoff = new Date(Date.now() - DEAD_LISTING_DAYS * 24 * 3600 * 1000);

  // Get all products with an eBay listing, check which are fully dead
  const listed = await Product.find({ ebayListingId: { $exists: true, $ne: null } }, 'ebayListingId status unavailableSince').lean();
  if (!listed.length) return;

  // Group by listingId — only end if ALL variants are unavailable for 7+ days
  const groups = {};
  for (const p of listed) {
    if (!groups[p.ebayListingId]) groups[p.ebayListingId] = [];
    groups[p.ebayListingId].push(p);
  }

  const deadIds = Object.entries(groups)
    .filter(([, variants]) =>
      variants.every(v => v.status === 'unavailable') &&
      variants.every(v => v.unavailableSince && new Date(v.unavailableSince) <= cutoff)
    )
    .map(([id]) => id);

  for (const listingId of deadIds) {
    try {
      await endListing(listingId);
      await Product.updateMany({ ebayListingId: listingId }, { $set: { ebayListingId: null } });
      console.log(`auto-ended dead listing: ${listingId} (all variants unavailable 7+ days)`);
      if (io) io.emit('tracker:listing:ended', { listingId });
    } catch (e) {
      console.error(`failed to end dead listing ${listingId}:`, e.message);
    }
  }
}

async function runDueChecks() {
  await checkDeadListings();
  const due = await Product.find({ nextCheck: { $lte: new Date() } });
  if (!due.length) return;

  if (io) io.emit("tracker:check:start", { count: due.length, time: new Date().toISOString() });

  const results = [];
  for (const p of due) {
    results.push(await checkProduct(p));
  }

  if (io) io.emit("tracker:check:done", { time: new Date().toISOString(), results });
}

async function runWeeklyOptimize() {
  const PORT = process.env.PORT || 5000;
  try {
    console.log('weekly-optimize: starting batch optimization of all listings…');
    const { data } = await axios.post(`http://localhost:${PORT}/api/ebay/batch-optimize`);
    console.log(`weekly-optimize: started — ${data.total} listings queued`);
  } catch (e) {
    console.error('weekly-optimize: failed to start:', e.message);
  }
}

function start(socketIo) {
  io = socketIo;
  // Check every 5 minutes which products are due
  cron.schedule("*/5 * * * *", runDueChecks);
  // Re-optimize all listings every Sunday at 3am
  cron.schedule("0 3 * * 0", runWeeklyOptimize);
}

// Called when user clicks "Check Now" for a specific product or all products
async function triggerNow() {
  const products = await Product.find();
  if (!products.length) return;

  if (io) io.emit("tracker:check:start", { count: products.length, time: new Date().toISOString() });

  const results = [];
  for (const p of products) {
    results.push(await checkProduct(p));
  }

  if (io) io.emit("tracker:check:done", { time: new Date().toISOString(), results });
}

// Force-retry all products with status error/unavailable/out_of_stock immediately
async function retryErrors() {
  const result = await Product.updateMany(
    { status: { $in: ['error', 'unavailable', 'out_of_stock'] } },
    { $set: { nextCheck: new Date(), failCount: 0 } }
  );
  console.log(`retryErrors: reset ${result.modifiedCount} products for immediate recheck`);
  return result.modifiedCount;
}

// Set nextCheck on a newly added product
function scheduleNew(product) {
  product.nextCheck = nextCheckDate(product);
}

function getNextCheck() {
  return null; // now per-product, not global
}

module.exports = { start, triggerNow, checkOne: checkProduct, scheduleNew, getNextCheck, retryErrors };
