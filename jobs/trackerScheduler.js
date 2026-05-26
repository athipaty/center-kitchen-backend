const cron = require("node-cron");
const { fetchProduct } = require("../scraper");
const Product = require("../models/tracker/Product");
const { syncEbayPrice } = require("./ebayPriceSync");

let io = null;

function randomInterval() {
  // Random ms between 2 and 4 hours
  return (Math.random() * 2 + 2) * 3600 * 1000;
}

function nextCheckDate() {
  return new Date(Date.now() + randomInterval());
}

function slowRetryDate() {
  // 24h retry for persistently unavailable products
  return new Date(Date.now() + 24 * 3600 * 1000);
}

async function checkProduct(p) {
  try {
    const info = await fetchProduct(p.url);
    const oldPrice = p.current;
    const dropped = info.price < oldPrice;

    p.current = info.price;
    if (info.price < p.lowest) p.lowest = info.price;
    if (info.image && !p.image) p.image = info.image;
    if (info.upc && !p.upc) p.upc = info.upc;
    if (info.isPrime !== undefined) p.isPrime = info.isPrime;
    if (info.variant) p.variant = info.variant;
    if (info.specs && Object.keys(info.specs).length) p.specs = info.specs;
    if (info.price !== oldPrice) {
      p.history.push({ price: info.price });
      if (p.history.length > 200) p.history = p.history.slice(-200);
    }

    // Reset failure tracking on successful fetch
    p.status = 'active';
    p.failCount = 0;

    if (p.ebayListingId) {
      try {
        await syncEbayPrice(p.ebayListingId, info.price, p.variant);
        console.log(`eBay price synced: listing ${p.ebayListingId} variant="${p.variant}" → $${info.price}`);
        if (io) io.emit('tracker:ebay:sync:ok', { productId: String(p._id) });
      } catch (ebayErr) {
        console.error(`eBay price sync failed for listing ${p.ebayListingId}:`, ebayErr.message);
        if (io) io.emit('tracker:ebay:sync:fail', { productId: String(p._id), error: ebayErr.message });
      }
    }
    p.nextCheck = nextCheckDate();
    await p.save();

    if (dropped && io) {
      io.emit("tracker:price:drop", { product: p.toObject(), oldPrice });
    }

    return { id: p._id, success: true, dropped, newPrice: info.price, oldPrice };
  } catch (err) {
    p.failCount = (p.failCount || 0) + 1;

    if (err.code === 'OUT_OF_STOCK') {
      p.status = 'out_of_stock';
      // After 3 consecutive OOS checks, slow down retries to 24h
      p.nextCheck = p.failCount >= 3 ? slowRetryDate() : nextCheckDate();
    } else {
      // Generic error — mark unavailable after 3 consecutive failures, slow retry
      p.status = p.failCount >= 3 ? 'unavailable' : 'error';
      p.nextCheck = p.failCount >= 3 ? slowRetryDate() : nextCheckDate();
    }

    if (io) io.emit('tracker:product:status', { productId: String(p._id), status: p.status, failCount: p.failCount });

    await p.save();
    return { id: p._id, success: false, status: p.status, failCount: p.failCount, error: err.message };
  }
}

async function runDueChecks() {
  const due = await Product.find({ nextCheck: { $lte: new Date() } });
  if (!due.length) return;

  if (io) io.emit("tracker:check:start", { count: due.length, time: new Date().toISOString() });

  const results = [];
  for (const p of due) {
    results.push(await checkProduct(p));
  }

  if (io) io.emit("tracker:check:done", { time: new Date().toISOString(), results });
}

function start(socketIo) {
  io = socketIo;
  // Check every 5 minutes which products are due
  cron.schedule("*/5 * * * *", runDueChecks);
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

// Set nextCheck on a newly added product
function scheduleNew(product) {
  product.nextCheck = nextCheckDate();
}

function getNextCheck() {
  return null; // now per-product, not global
}

module.exports = { start, triggerNow, checkOne: checkProduct, scheduleNew, getNextCheck };
