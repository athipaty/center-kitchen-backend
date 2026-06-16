const express = require("express");
const router = express.Router();
const axios = require("axios");
const Product = require("../../models/tracker/Product");

// 30-minute cache for deal search results — each search costs 5 credits
const _dealSearchCache = new Map(); // query → { deals, expiresAt }
const DEAL_CACHE_TTL = 30 * 60 * 1000;
const TrackerSettings = require("../../models/tracker/TrackerSettings");
const { cleanUrl, extractAsin, fetchProduct } = require("../../scraper");
const scheduler = require("../../jobs/trackerScheduler");
const { deleteCloudinaryFolder } = require("../../utils/cloudinaryUtils");

// GET current tracker settings (saleModeActive, discovery results, etc.)
router.get("/settings", async (req, res) => {
  try {
    const settings = await TrackerSettings.findById('tracker').lean();
    res.json({
      saleModeActive: settings?.saleModeActive ?? false,
      lastDiscoveryRun: settings?.lastDiscoveryRun ?? null,
      lastDiscoveryAdded: settings?.lastDiscoveryAdded ?? [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST dismiss the discovery banner (clears lastDiscoveryAdded)
router.post("/settings/dismiss-discovery", async (req, res) => {
  try {
    await TrackerSettings.findByIdAndUpdate('tracker',
      { $set: { lastDiscoveryAdded: [] } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST manually trigger product discovery
// Body: { slots: N } — if omitted, falls back to checking selling limits
router.post("/discover", async (req, res) => {
  try {
    const { runProductDiscovery } = require('../../jobs/productDiscovery');
    let slots = req.body?.slots;
    if (!slots || slots <= 0) {
      // Fall back to selling limits API
      const axios = require('axios');
      const PORT = process.env.PORT || 5000;
      const { data: limits } = await axios.get(`http://localhost:${PORT}/api/ebay/selling-limits`, { timeout: 30000 });
      slots = Math.max(0, (limits.items?.remaining || 0) - 1);
    }
    if (!slots || slots <= 0) return res.status(400).json({ error: 'No available slots' });
    const opts = {};
    if (req.body?.maxVariantsPerProduct) opts.maxVariantsPerProduct = Number(req.body.maxVariantsPerProduct);
    res.json({ started: true, slots, opts });
    const io = req.app.get('io') || null;
    runProductDiscovery(io, slots, opts).catch(e => console.error('discovery trigger error:', e.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// GET all tracked products (excludes archived — zero-view listings ended by the auto-end job)
router.get("/", async (req, res) => {
  try {
    const products = await Product.find({ status: { $ne: 'archived' } }).sort({ createdAt: -1 });
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
    const groupId = extractAsin(cleanedUrl);
    res.json({ title: info.title, price: info.price, currency: info.currency, image: info.image, isPrime: info.isPrime || false, variants, groupId });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET search Amazon for items currently on sale (have a strikethrough/original price)
router.get("/search-deals", async (req, res) => {
  try {
    const rawQuery = (req.query.query || "").trim();
    const category = (req.query.category || "").trim();
    // A category alone isn't a great search query on its own — pairing it with
    // "deals" steers Amazon's search toward discounted listings in that category.
    const searchTerm = rawQuery || (category ? `${category} deals` : "");
    if (!searchTerm) return res.status(400).json({ error: "query or category is required" });
    if (!process.env.SCRAPER_API_KEY) return res.status(500).json({ error: "SCRAPER_API_KEY not set" });

    const cacheKey = searchTerm.toLowerCase();
    const cached = _dealSearchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`search-deals: cache hit for "${searchTerm}" — 0 credits used`);
      return res.json({ query: searchTerm, category: category || null, deals: cached.deals, cached: true });
    }

    const { data } = await axios.get("https://api.scraperapi.com/structured/amazon/search/v1", {
      params: { api_key: process.env.SCRAPER_API_KEY, query: searchTerm, country: "us" },
      timeout: 30000,
    });

    const results = data.results || data.organic_results || data.products || [];
    const seen = new Set();
    const deals = results
      .filter(r => {
        if (!r.asin || !(r.original_price?.price > r.price) || seen.has(r.asin)) return false;
        seen.add(r.asin);
        return true;
      })
      .map(r => {
        const price = r.price;
        const originalPrice = r.original_price.price;
        return {
          asin: r.asin,
          title: r.name,
          image: r.image || null,
          url: `https://www.amazon.com/dp/${r.asin}`,
          price,
          originalPrice,
          currency: r.price_symbol || "$",
          discountPercent: Math.round((1 - price / originalPrice) * 100),
          rating: r.stars || null,
          reviewCount: r.total_reviews || 0,
          isPrime: !!r.has_prime,
          isLimitedDeal: !!r.is_limited_deal,
        };
      })
      .sort((a, b) => b.discountPercent - a.discountPercent);

    _dealSearchCache.set(cacheKey, { deals, expiresAt: Date.now() + DEAL_CACHE_TTL });
    res.json({ query: searchTerm, category: category || null, deals });
  } catch (err) {
    res.status(502).json({ error: err.response?.data?.message || err.message });
  }
});

// POST add a product to track
router.post("/", async (req, res) => {
  try {
    const { url, groupId } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });

    const cleanedUrl = cleanUrl(url);

    const existing = await Product.findOne({ url: cleanedUrl, status: { $ne: 'archived' } });
    if (existing) return res.status(409).json({ error: "Already tracking this product." });

    const info = await fetchProduct(cleanedUrl);

    const product = new Product({
      url: cleanedUrl,
      title: info.title,
      image: info.image || null,
      images: info.images || [],
      upc: info.upc || null,
      currency: info.currency,
      current: info.price,
      lowest: info.price,
      listPrice: info.listPrice ?? null,
      history: [{ price: info.price }],
      isPrime: info.isPrime || false,
      variant: info.variant || null,
      groupId: groupId || null,
      specs: info.specs || {},
      bullets: info.bullets || [],
    });

    scheduler.scheduleNew(product);
    await product.save();
    res.json(product);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// PATCH update eBay listing ID for a product
router.patch("/:id/ebay", async (req, res) => {
  try {
    const { ebayListingId, cloudinaryFolder } = req.body;
    const update = { ebayListingId: ebayListingId || null, listedAt: ebayListingId ? new Date() : null };
    if (cloudinaryFolder !== undefined) update.cloudinaryFolder = cloudinaryFolder || null;
    const product = await Product.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// POST re-fetch all hi-res images for a product directly from Amazon page
// Uses a lightweight regex extraction (no ScraperAPI needed) and updates the DB
router.post("/:id/refresh-images", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    const axios = require("axios");
    const { data: html } = await axios.get(product.url, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    // Extract all hiRes image URLs from Amazon page JS data
    const hiResMatches = [...html.matchAll(/"hiRes"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/g)];
    const hiResUrls = [...new Set(hiResMatches.map(m => m[1]))];

    // Fallback: large images from img tags
    let images = hiResUrls;
    if (!images.length) {
      const largMatches = [...html.matchAll(/https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9]+\._[A-Z_0-9]+_\.jpg/g)];
      images = [...new Set(largMatches.map(m => m[0]))];
    }

    if (images.length) {
      await Product.findByIdAndUpdate(product._id, { images, image: images[0] });
      product.images = images;
      product.image = images[0];
    }

    res.json({ ok: true, count: images.length, images });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// DELETE remove a product — soft-delete (archive) so discovery never re-lists the same ASIN
router.delete("/:id", async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'archived', archivedAt: new Date(), ebayListingId: null, listedAt: null } },
      { new: false }
    );
    if (!product) return res.status(404).json({ error: "Product not found" });

    // End the eBay listing if one was active
    if (product.ebayListingId) {
      const PORT = process.env.PORT || 5000;
      axios.delete(`http://localhost:${PORT}/api/ebay/listing/${product.ebayListingId}`).catch(e => {
        console.warn(`delete: failed to end eBay listing ${product.ebayListingId}:`, e.message);
      });
    }

    if (product.cloudinaryFolder) {
      deleteCloudinaryFolder(product.cloudinaryFolder).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST reset all error/unavailable/OOS products for immediate recheck
router.post("/retry-errors", async (req, res) => {
  try {
    const count = await scheduler.retryErrors();
    res.json({ ok: true, reset: count });
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

    // Proactively push qty=0 if already OOS/unavailable before re-scraping
    if (product.ebayListingId && (product.status === 'out_of_stock' || product.status === 'unavailable')) {
      try {
        const { syncEbayQty } = require("../../jobs/ebayPriceSync");
        await syncEbayQty(product.ebayListingId, product.variant, 0);
        console.log(`proactive qty=0: listing ${product.ebayListingId} variant="${product.variant}"`);
      } catch (e) {
        console.error('proactive syncEbayQty failed:', e.message);
      }
    }

    const saleMode = req.body?.saleMode === true;
    await scheduler.checkOne(product, saleMode);
    const updated = await Product.findById(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST immediately push qty=0 to eBay for all currently OOS / unavailable variants
router.post("/fix-oos-qty", async (req, res) => {
  try {
    const { syncEbayQty } = require("../../jobs/ebayPriceSync");
    const oosProducts = await Product.find({
      status: { $in: ['out_of_stock', 'unavailable'] },
      ebayListingId: { $exists: true, $ne: null },
    });

    const results = [];
    for (const p of oosProducts) {
      try {
        await syncEbayQty(p.ebayListingId, p.variant, 0);
        results.push({ id: p._id, variant: p.variant, ok: true });
        console.log(`fix-oos-qty: qty=0 pushed for listing ${p.ebayListingId} variant="${p.variant}"`);
      } catch (e) {
        results.push({ id: p._id, variant: p.variant, ok: false, error: e.message });
        console.error(`fix-oos-qty failed for ${p._id}:`, e.message);
      }
    }
    res.json({ fixed: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET monitoring status (next check time)
router.get("/status", (req, res) => {
  res.json({ nextCheck: scheduler.getNextCheck() });
});

// POST generate SEO-optimized eBay listing title using Claude
router.post("/ebay-title", async (req, res) => {
  const { title, specs, variant, upc } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const specsText = specs
      ? Object.entries(specs)
          .filter(([k, v]) => v != null && k !== 'asin')
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
          .join(', ')
      : '';

    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: `Write a single SEO-optimized eBay listing title for this product. Max 80 characters. Include brand, model number, key specs buyers search for. No trademark symbols (® ™), no promotional words (Free Shipping, Best Price, etc.). Output ONLY the title, nothing else.

Amazon title: ${title}${variant ? `\nVariant: ${variant}` : ''}${specsText ? `\nSpecs: ${specsText}` : ''}${upc ? `\nUPC: ${upc}` : ''}`,
      }],
    });

    const generated = msg.content[0].text.trim().replace(/^["'`]+|["'`]+$/g, '');
    res.json({ title: generated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET profit summary — aggregate margin/profit data across all active listed products
router.get("/profit-summary", async (req, res) => {
  try {
    const products = await Product.find(
      { ebayListingId: { $exists: true, $ne: null } },
      'title ebayListingId current status variant'
    ).lean();

    // 2% margin formula — mirrors src/utils/pricing.js (includes 8.5% Amazon tax)
    function calcEbayPrice(ap) {
      const c = ap * 1.085;
      return Math.floor((c + 0.30) / (1 - 0.1325 - 0.05 - 0.02)) + 0.99;
    }
    function calcFee(ep) { return +(ep * 0.1325 + 0.30).toFixed(2); }

    // Group by listingId
    const groups = {};
    for (const p of products) {
      if (!groups[p.ebayListingId]) groups[p.ebayListingId] = [];
      groups[p.ebayListingId].push(p);
    }

    const listings = Object.entries(groups).map(([listingId, variants]) => {
      const primary = variants.find(v => v.title && v.title !== 'Unknown product') || variants[0];
      const rows = variants.map(v => {
        const ebay   = calcEbayPrice(v.current);
        const fee    = calcFee(ebay);
        const profit = +(ebay - v.current - fee).toFixed(2);
        const margin = +((profit / ebay) * 100).toFixed(1);
        return { amazon: v.current, ebay, profit, margin, variant: v.variant, status: v.status };
      });
      const avg = key => +(rows.reduce((s, r) => s + r[key], 0) / rows.length).toFixed(2);
      return {
        listingId,
        title: primary.title.slice(0, 70),
        variantCount: variants.length,
        avgAmazon: avg('amazon'),
        avgEbay:   avg('ebay'),
        avgProfit: avg('profit'),
        avgMargin: +((rows.reduce((s, r) => s + r.margin, 0) / rows.length).toFixed(1)),
        variants: rows,
      };
    }).sort((a, b) => b.avgProfit - a.avgProfit);

    const n = listings.length;
    res.json({
      listings,
      summary: {
        totalListings:       n,
        totalVariants:       products.length,
        avgMargin:           n ? +(listings.reduce((s, l) => s + l.avgMargin, 0) / n).toFixed(1) : 0,
        totalPotentialProfit:+(listings.reduce((s, l) => s + l.avgProfit * l.variantCount, 0)).toFixed(2),
        highMargin:          listings.filter(l => l.avgMargin >= 25).length,
        thinMargin:          listings.filter(l => l.avgMargin < 15).length,
        topEarners:          listings.slice(0, 5),
        needsAttention:      listings.filter(l => l.avgMargin < 15),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
