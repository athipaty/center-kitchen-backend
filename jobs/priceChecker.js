const cron = require("node-cron");
const Anthropic = require("@anthropic-ai/sdk");
const WatchItem = require("../models/WatchItem");
const PriceHistory = require("../models/PriceHistory");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const fmtUSD = (v) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);

async function checkItem(itemId) {
  const item = await WatchItem.findById(itemId);
  if (!item) throw new Error("Item not found");

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 400,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    system: `Search Amazon for the current price and stock status of a product.
Return ONLY valid JSON, no markdown, no backticks:
{
  "current_price": 199.99,
  "in_stock": true,
  "note": "optional short note"
}
If the product is not found or out of stock set in_stock to false and current_price to null.`,
    messages: [
      {
        role: "user",
        content: `Check the current Amazon price and stock for: ${item.product}${
          item.amazonUrl ? `. URL: ${item.amazonUrl}` : ""
        }`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No AI response");

  const result = JSON.parse(
    textBlock.text.replace(/```json|```/g, "").trim()
  );

  const now = new Date();
  const prevPrice = item.amazonPrice;

  // Out of stock
  if (!result.in_stock) {
    item.status = "out_of_stock";
    item.alerts = [
      `⚠️ Amazon listing out of stock as of ${now.toLocaleString()}`,
    ];
    item.lastChecked = now;
    await item.save();
    return item;
  }

  // Price increased
  if (result.current_price && result.current_price > prevPrice + 0.5) {
    const diff = result.current_price - prevPrice;
    const newProfit = item.targetSellPrice - result.current_price;
    item.status = "price_increased";
    item.alerts = [
      `📈 Amazon price increased ${fmtUSD(prevPrice)} → ${fmtUSD(result.current_price)} (+${fmtUSD(diff)}) on ${now.toLocaleString()}. New est. profit: ${fmtUSD(newProfit)}`,
    ];
    item.amazonPrice = result.current_price;
    item.lastChecked = now;
    await item.save();
    await PriceHistory.create({
      watchItemId: item._id,
      amazonPrice: result.current_price,
      ebayCompetitorPrice: item.ebayCompetitorPrice,
    });
    return item;
  }

  // Price same or decreased
  if (result.current_price && result.current_price !== prevPrice) {
    item.amazonPrice = result.current_price;
  }
  item.status = "active";
  item.alerts = [];
  item.lastChecked = now;
  await item.save();
  await PriceHistory.create({
    watchItemId: item._id,
    amazonPrice: result.current_price || prevPrice,
    ebayCompetitorPrice: item.ebayCompetitorPrice,
  });

  return item;
}

function startPriceChecker() {
  cron.schedule("0 * * * *", async () => {
    console.log(`[${new Date().toLocaleTimeString()}] Running hourly Amazon price check...`);
    try {
      const items = await WatchItem.find({ status: { $ne: "out_of_stock" } });
      console.log(`Checking ${items.length} product(s)...`);
      for (const item of items) {
        try {
          await checkItem(item._id.toString());
          console.log(`✅ Checked: ${item.product}`);
        } catch (err) {
          console.error(`❌ Failed: ${item.product}:`, err.message);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      console.log("Hourly check complete.");
    } catch (err) {
      console.error("Price checker error:", err.message);
    }
  });
  console.log("⏰ Price checker scheduled — runs every hour");
}

module.exports = { checkItem, startPriceChecker };