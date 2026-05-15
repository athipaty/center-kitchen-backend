const { fetchProduct } = require("../scraper");
const Product = require("../models/tracker/Product");

let nextCheckTime = null;
let timeoutId = null;
let io = null;

// Random ms between 1 and 3 hours
function randomInterval() {
  return (Math.random() * 2 + 1) * 3600 * 1000;
}

function getNextCheck() {
  return nextCheckTime;
}

async function runCheck() {
  const products = await Product.find();
  if (!products.length) {
    scheduleNext();
    return;
  }

  if (io) io.emit("tracker:check:start", { count: products.length, time: new Date().toISOString() });

  const results = [];
  for (const p of products) {
    try {
      const info = await fetchProduct(p.url);
      const oldPrice = p.current;
      const dropped = info.price < oldPrice;

      p.current = info.price;
      if (info.price < p.lowest) p.lowest = info.price;
      p.history.push({ price: info.price });
      if (p.history.length > 200) p.history = p.history.slice(-200);
      await p.save();

      results.push({ id: p._id, success: true, dropped, newPrice: info.price, oldPrice });

      if (dropped && io) {
        io.emit("tracker:price:drop", { product: p.toObject(), oldPrice });
      }
    } catch (err) {
      results.push({ id: p._id, success: false, error: err.message });
    }
  }

  if (io) io.emit("tracker:check:done", { time: new Date().toISOString(), results });
  scheduleNext();
}

function scheduleNext() {
  if (timeoutId) clearTimeout(timeoutId);
  const ms = randomInterval();
  nextCheckTime = new Date(Date.now() + ms).toISOString();
  if (io) io.emit("tracker:scheduled", { nextCheck: nextCheckTime });
  timeoutId = setTimeout(runCheck, ms);
}

function start(socketIo) {
  io = socketIo;
  scheduleNext();
}

async function triggerNow() {
  if (timeoutId) clearTimeout(timeoutId);
  await runCheck();
}

module.exports = { start, triggerNow, getNextCheck };
