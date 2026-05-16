const express = require("express");
const router = express.Router();
const axios = require("axios");
const Product = require("../../models/tracker/Product");
const { cleanUrl, fetchProduct } = require("../../scraper");
const scheduler = require("../../jobs/trackerScheduler");

// GET raw ScraperAPI response for an ASIN — for debugging variant field names
router.get("/debug-raw", async (req, res) => {
  const { asin } = req.query;
  if (!asin) return res.status(400).json({ error: "asin is required" });
  if (!process.env.SCRAPER_API_KEY) return res.status(500).json({ error: "SCRAPER_API_KEY not set" });
  try {
    const { data } = await axios.get(
      `https://api.scraperapi.com/structured/amazon/product/v1`,
      { params: { api_key: process.env.SCRAPER_API_KEY, asin }, timeout: 60000 }
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// GET all tracked products
router.get("/", async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST preview a URL — returns scraped info + variants without saving anything
router.post("/preview", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });
    const cleanedUrl = cleanUrl(url);
    const info = await fetchProduct(cleanedUrl);
    // Extract base domain so variant URLs stay on the same Amazon locale
    const domainMatch = cleanedUrl.match(/(https?:\/\/[^/]+)/);
    const baseDomain = domainMatch ? domainMatch[1] : "https://www.amazon.com";
    const variants = (info.variants || []).map(v => ({
      ...v,
      url: `${baseDomain}/dp/${v.asin}`,
    }));
    res.json({ title: info.title, price: info.price, currency: info.currency, image: info.image, variants });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST add a product to track
router.post("/", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });

    const cleanedUrl = cleanUrl(url);

    const existing = await Product.findOne({ url: cleanedUrl });
    if (existing) return res.status(409).json({ error: "Already tracking this product." });

    const info = await fetchProduct(cleanedUrl);

    const product = new Product({
      url: cleanedUrl,
      title: info.title,
      image: info.image || null,
      upc: info.upc || null,
      currency: info.currency,
      current: info.price,
      lowest: info.price,
      history: [{ price: info.price }],
    });

    scheduler.scheduleNew(product);
    await product.save();
    res.json(product);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// DELETE remove a product
router.delete("/:id", async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST trigger manual price check now — waits for completion
router.post("/check", async (req, res) => {
  try {
    await scheduler.triggerNow();
    const products = await Product.find().sort({ createdAt: -1 });
    res.json({ ok: true, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST check a single product by ID
router.post("/check/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });
    await scheduler.checkOne(product);
    const updated = await Product.findById(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET monitoring status (next check time)
router.get("/status", (req, res) => {
  res.json({ nextCheck: scheduler.getNextCheck() });
});

module.exports = router;
