const express = require("express");
const router = express.Router();
const GroceryProduct = require("../../models/grocery/GroceryProduct");
const { checkProductPrice } = require("../../utils/groceryScraper");

// List all tracked products, optionally filtered by category.
router.get("/products", async (req, res) => {
  try {
    const filter = { active: true };
    if (req.query.category) filter.category = req.query.category;
    const products = await GroceryProduct.find(filter).sort({ category: 1, currentPrice: 1 }).lean();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Distinct categories currently tracked — powers the frontend's category filter.
router.get("/categories", async (req, res) => {
  try {
    const categories = await GroceryProduct.distinct("category", { active: true });
    res.json(categories.sort());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cheapest active listing per category (one row per category, lowest currentPrice).
router.get("/cheapest", async (req, res) => {
  try {
    const cheapest = await GroceryProduct.aggregate([
      { $match: { active: true } },
      { $sort: { currentPrice: 1 } },
      { $group: { _id: "$category", product: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$product" } },
      { $sort: { category: 1 } },
    ]);
    res.json(cheapest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single product detail, including full price history.
router.get("/products/:id", async (req, res) => {
  try {
    const product = await GroceryProduct.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ error: "Not found" });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start tracking a new product: scrapes it once immediately so the entry is
// created with a real price rather than a placeholder.
router.post("/products", async (req, res) => {
  try {
    const { supermarket, category, searchQuery } = req.body;
    if (!supermarket || !category || !searchQuery) {
      return res.status(400).json({ error: "supermarket, category, and searchQuery are required" });
    }

    const scraped = await checkProductPrice({ supermarket, searchQuery });
    const product = await GroceryProduct.create({
      name: scraped.name,
      supermarket,
      category,
      searchQuery,
      packSize: scraped.packSize,
      imageUrl: scraped.imageUrl,
      currentPrice: scraped.price,
      history: [{ price: scraped.price }],
      lastChecked: new Date(),
    });
    res.status(201).json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-scrape one product on demand (the scheduled job does this automatically,
// but a manual trigger is useful right after adding a product or for debugging).
router.post("/products/:id/check", async (req, res) => {
  try {
    const product = await GroceryProduct.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Not found" });

    const scraped = await checkProductPrice(product);
    product.history.push({ price: scraped.price });
    product.currentPrice = scraped.price;
    if (scraped.imageUrl) product.imageUrl = scraped.imageUrl;
    if (scraped.packSize) product.packSize = scraped.packSize;
    product.lastChecked = new Date();
    product.lastCheckFailed = false;
    await product.save();
    res.json(product);
  } catch (err) {
    // Mark the failure but don't 500 the whole request on a transient scrape miss
    await GroceryProduct.findByIdAndUpdate(req.params.id, { lastCheckFailed: true, lastChecked: new Date() }).catch(() => {});
    res.status(502).json({ error: err.message });
  }
});

router.delete("/products/:id", async (req, res) => {
  try {
    await GroceryProduct.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
