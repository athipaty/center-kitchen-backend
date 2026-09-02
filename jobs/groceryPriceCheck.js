const cron = require("node-cron");
const GroceryProduct = require("../models/grocery/GroceryProduct");
const { checkProductPrice } = require("../utils/groceryScraper");

// Re-scrape every actively tracked product once a day. Sequential with a small
// delay between requests -- ScraperAPI is metered per call, and there's no
// urgency to parallelize a handful of grocery items.
async function runDailyPriceCheck() {
  const products = await GroceryProduct.find({ active: true });
  console.log(`[groceryPriceCheck] checking ${products.length} products...`);

  let updated = 0, failed = 0;
  for (const product of products) {
    try {
      const scraped = await checkProductPrice(product);
      product.history.push({ price: scraped.price });
      product.currentPrice = scraped.price;
      if (scraped.imageUrl) product.imageUrl = scraped.imageUrl;
      if (scraped.packSize) product.packSize = scraped.packSize;
      product.lastChecked = new Date();
      product.lastCheckFailed = false;
      await product.save();
      updated++;
    } catch (err) {
      console.error(`[groceryPriceCheck] failed for "${product.name}" (${product.supermarket}):`, err.message);
      product.lastCheckFailed = true;
      product.lastChecked = new Date();
      await product.save().catch(saveErr =>
        console.error(`[groceryPriceCheck] also failed to save lastCheckFailed flag for "${product.name}":`, saveErr.message)
      );
      failed++;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`[groceryPriceCheck] done — ${updated} updated, ${failed} failed`);
}

function start() {
  cron.schedule("0 4 * * *", runDailyPriceCheck, { timezone: "Asia/Singapore" }); // 4am SGT daily
  console.log("✅ groceryPriceCheck scheduled: 04:00 SGT daily");
}

module.exports = { start, runDailyPriceCheck };
