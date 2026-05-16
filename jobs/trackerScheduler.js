const cron = require("node-cron");
const { fetchProduct } = require("../scraper");
const Product = require("../models/tracker/Product");

let io = null;

function randomInterval() {
  // Random ms between 1 and 3 hours
  return (Math.random() * 2 + 1) * 3600 * 1000;
}

function nextCheckDate() {
  return new Date(Date.now() + randomInterval());
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
    if (info.price !== oldPrice) {
      p.history.push({ price: info.price });
      if (p.history.length > 200) p.history = p.history.slice(-200);
    }
    p.nextCheck = nextCheckDate();
    await p.save();

    if (dropped && io) {
      io.emit("tracker:price:drop", { product: p.toObject(), oldPrice });
    }

    return { id: p._id, success: true, dropped, newPrice: info.price, oldPrice };
  } catch (err) {
    // Still reschedule even on failure
    p.nextCheck = nextCheckDate();
    await p.save();
    return { id: p._id, success: false, error: err.message };
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
