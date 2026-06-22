const express = require("express");
const router = express.Router();
const axios = require("axios");
const Product = require("../../models/tracker/Product");

// 30-minute cache for deal search results — each search costs 5 credits
const _dealSearchCache = new Map(); // query → { deals, expiresAt }
const DEAL_CACHE_TTL = 12 * 60 * 60 * 1000; // 12h — conserves Keepa tokens (Deal API costs 5/call)
const TrackerSettings = require("../../models/tracker/TrackerSettings");
const { cleanUrl, extractAsin, fetchProduct } = require("../../scraper");
const scheduler = require("../../jobs/trackerScheduler");
const { deleteCloudinaryFolder } = require("../../utils/cloudinaryUtils");
const { endListing } = require("../../jobs/ebayPriceSync");

router.get("/settings", async (req, res) => {
  res.json({});
});

// GET raw Keepa response for an ASIN — for debugging product field names
router.get("/debug-raw", async (req, res) => {
  const { asin } = req.query;
  if (!asin) return res.status(400).json({ error: "asin is required" });
  if (!process.env.KEEPA_API_KEY) return res.status(500).json({ error: "KEEPA_API_KEY not set" });
  try {
    const { data } = await axios.get("https://api.keepa.com/product", {
      params: { key: process.env.KEEPA_API_KEY, asin, domain: 1, stats: 1, history: 1, buybox: 1 },
      timeout: 30000,
    });
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
    const groupId = extractAsin(cleanedUrl);
    res.json({ title: info.title, price: info.price, currency: info.currency, image: info.image, isPrime: info.isPrime || false, variants, groupId });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Amazon browse-node IDs that Keepa uses for category filtering (matches Amazon's native IDs)
const KEEPA_CATEGORY_IDS = {
  'Electronics':              172282,
  'Home & Kitchen':           1055398,
  'Kitchen & Dining':         284507,
  'Tools & Home Improvement': 228013,
  'Sports & Outdoors':        3375251,
  'Toys & Games':             165793011,
  'Beauty & Personal Care':   11055981,
  'Clothing, Shoes & Jewelry':7141123011,
  'Health & Household':       3760901,
  'Pet Supplies':             2619533011,
  'Office Products':          1064954,
  'Patio, Lawn & Garden':     2972638011,
  'Baby':                     165796011,
  'Grocery & Gourmet Food':   16310101,
  'Automotive':               15690151,
  'Books':                    283155,
  'Video Games':              468642,
};

// Keepa price helpers (inline — avoids import coupling with scraper.js)
function _kPrice(cents) { return (cents != null && cents !== -1 && cents > 0) ? cents / 100 : null; }
function _keepaCurrentPrice(s) {
  if (!s?.current) return null;
  return _kPrice(s.current[3]) || _kPrice(s.current[0]) || _kPrice(s.current[7]) || null;
}
function _keepaListPrice(s) { return _kPrice(s?.current?.[11]) || null; }
function _keepaImages(p) {
  if (!p.imagesCSV) return [];
  return p.imagesCSV.split(',').filter(Boolean).map(s => `https://images-na.ssl-images-amazon.com/images/I/${s.trim()}`);
}

// GET search for items under $15 with recent price drops using Keepa Deal API
// Deal API returns up to 150 items per category; price/rating filters applied client-side
// since API-side filters are unreliable. Ratings fetched via a second batch product call.
router.get("/search-deals", async (req, res) => {
  try {
    const category = (req.query.category || "").trim();
    if (!category) return res.status(400).json({ error: "category is required" });
    if (!process.env.KEEPA_API_KEY) return res.status(500).json({ error: "KEEPA_API_KEY not set" });

    const categoryId = KEEPA_CATEGORY_IDS[category];
    if (!categoryId) return res.status(400).json({ error: `Unknown category "${category}". Must be one of: ${Object.keys(KEEPA_CATEGORY_IDS).join(', ')}` });

    const cacheKey = category.toLowerCase();
    const cached = _dealSearchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`search-deals: cache hit for "${category}" — 0 tokens`);
      return res.json({ category, deals: cached.deals, cached: true });
    }

    const keepaKey = process.env.KEEPA_API_KEY;

    // Step 1: Keepa Deal API — returns up to 150 recent price-drop items per category.
    // Keepa Deal response uses dr[] array where each item has: asin, title, current (price array),
    // avg (4-period price averages), image (byte array of slug), deltaPercent (2D change array).
    // Use GET — POST with URLSearchParams has encoding issues in some Node.js environments.
    // priceTypes must be a single integer: 0=Amazon, 1=New, 7=FBA (not an array)
    const { data: dealData } = await axios.get("https://api.keepa.com/deal", {
      params: {
        key: keepaKey,
        selection: JSON.stringify({
          domainId: 1,
          priceTypes: 0,
          limit: 150,
          includeCategories: [categoryId],
        }),
      },
      timeout: 30000,
    });

    const drItems = dealData.deals?.dr || [];
    if (!drItems.length) return res.json({ category, deals: [] });

    // Best buyable price for this deal item (same index priority as scraper.js)
    function dealPrice(cur) {
      if (!Array.isArray(cur)) return null;
      const c = v => (v > 0 ? v / 100 : null);
      return c(cur[0]) || c(cur[7]) || c(cur[1]) || null;
    }

    // Keepa stores image slugs as byte arrays — convert to string
    function slugFromBytes(b) {
      if (!b) return null;
      if (typeof b === "string") return b;
      try { return Buffer.from(b).toString("utf-8"); } catch { return null; }
    }

    // Step 2: client-side filter — keep only items priced ≤ $15
    const candidates = drItems.filter(d => {
      const p = dealPrice(d.current);
      return p !== null && p <= 15;
    }).slice(0, 50);

    if (!candidates.length) {
      console.log(`search-deals "${category}": dr=${drItems.length} — no items under $15`);
      return res.json({ category, deals: [] });
    }

    // Step 3: batch-fetch product data to get ratings (not included in Deal response)
    const asinList = [...new Set(candidates.map(d => d.asin))];
    const { data: pData } = await axios.get("https://api.keepa.com/product", {
      params: { key: keepaKey, asin: asinList.join(","), domain: 1, stats: 0, history: 0 },
      timeout: 60000,
    });
    if (pData.tokensLeft != null) console.log(`search-deals: tokensLeft=${pData.tokensLeft}`);

    const ratingMap = {}, reviewMap = {}, soldMap = {};
    for (const p of (pData.products || [])) {
      ratingMap[p.asin] = p.rating > 0 ? p.rating / 10 : null;
      reviewMap[p.asin] = p.countReviews || 0;
      soldMap[p.asin]   = p.monthlySold > 0 ? p.monthlySold : null;
    }

    // Step 4: apply 4+ star filter and build the response shape the frontend expects
    const CDN = "https://images-na.ssl-images-amazon.com/images/I/";
    const deals = candidates
      .filter(d => ratingMap[d.asin] == null || ratingMap[d.asin] >= 4.0)
      .map(d => {
        const cur = d.current || [];
        const price = dealPrice(cur);
        // 90-day average Amazon price as the "original/was" reference price
        const avg90Amazon = Array.isArray(d.avg?.[1]) && d.avg[1][0] > 0 ? d.avg[1][0] / 100 : null;
        const originalPrice = avg90Amazon && avg90Amazon > price ? avg90Amazon : null;
        const discountPercent = originalPrice ? Math.round((1 - price / originalPrice) * 100) : null;
        const slug = slugFromBytes(d.image);
        return {
          asin:            d.asin,
          title:           d.title || "",
          image:           slug ? `${CDN}${slug}` : null,
          url:             `https://www.amazon.com/dp/${d.asin}`,
          price,
          originalPrice,
          currency:        "$",
          discountPercent: discountPercent > 0 ? discountPercent : null,
          rating:          ratingMap[d.asin] || null,
          reviewCount:     reviewMap[d.asin] || 0,
          monthlySold:     soldMap[d.asin] || null,
          isPrime:         cur[0] > 0,  // sold by Amazon = definitely Prime
          isLimitedDeal:   !!(d.lightningStart && d.lightningEnd),
        };
      })
      .sort((a, b) => (b.discountPercent || 0) - (a.discountPercent || 0));

    console.log(`search-deals "${category}": dr=${drItems.length} under$15=${candidates.length} passed=${deals.length}`);
    _dealSearchCache.set(cacheKey, { deals, expiresAt: Date.now() + DEAL_CACHE_TTL });
    res.json({ category, deals });
  } catch (err) {
    if (err.response?.status === 429 || err.response?.status === 429)
      return res.status(503).json({ error: "Keepa rate limit — deal search is cached 12h, try again shortly." });
    res.status(502).json({ error: err.response?.data?.message || err.message });
  }
});

// POST add a product to track
router.post("/", async (req, res) => {
  try {
    const { url, groupId } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });

    const cleanedUrl = cleanUrl(url);

    const existing = await Product.findOne({ url: cleanedUrl });
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

    // Always upload to Cloudinary in background — ensures cloudinaryFolder + Cloudinary URLs
    // are set for every product, matching the old ScraperAPI behavior where all images were
    // uploaded to Cloudinary before eBay listing. Keepa images passed as seed fallback.
    fetchAndUploadImages(product, info.images || []).catch(e => console.error(`auto-image: failed for ${product._id}:`, e.message));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// PATCH update groupId (and/or isPrime) — used when re-tracking joins an existing group
router.patch("/:id", async (req, res) => {
  try {
    const allowed = ['groupId', 'isPrime'];
    const update = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }
    if (!Object.keys(update).length) return res.status(400).json({ error: 'No updatable fields' });
    const product = await Product.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update eBay listing ID for a product
router.patch("/:id/ebay", async (req, res) => {
  try {
    const { ebayListingId, cloudinaryFolder, ebayPrice } = req.body;
    const update = { ebayListingId: ebayListingId || null, listedAt: ebayListingId ? new Date() : null };
    if (cloudinaryFolder !== undefined) update.cloudinaryFolder = cloudinaryFolder || null;
    if (ebayPrice !== undefined) update.ebayPrice = ebayPrice != null ? Number(ebayPrice) : null;
    const product = await Product.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Shared helper: scrape Amazon for images and upload to Cloudinary.
// Called automatically on product add (background) and from refresh-images route.
async function fetchAndUploadImages(product, seedImages = []) {
  const crypto = require('crypto');
  let amazonImages = [];
  try {
    const { data: html } = await axios.get(product.url, {
      timeout: 15000,
      headers: {
        // Mobile UA bypasses Amazon's server-side blocking that desktop UA triggers
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const urlRe = pat => [...html.matchAll(pat)].map(m => m[1]);
    // Primary: hiRes JSON data (desktop-style embedded JSON, sometimes present in mobile too)
    const hiRes   = urlRe(/"hiRes":"(https:\/\/(?:m\.media|images-na\.ssl)-amazon\.com\/images\/I\/[^"]+)"/g);
    const large   = urlRe(/"large":"(https:\/\/(?:m\.media|images-na\.ssl)-amazon\.com\/images\/I\/[^"]+)"/g);
    const mainImg = urlRe(/id="landingImage"[^>]+src="([^"]+)"/g);
    const dynImg  = urlRe(/"dynamic_image_url":"([^"]+)"/g);
    const srcSet  = urlRe(/srcset="([^ ,]+)[^"]*" id="imgBlkFront"/g);
    // Mobile fallback: extract full-res gallery images from _AC_SL1500_ or _AC_ URLs, skip thumbnails
    const acImgs  = [...new Set(
      [...html.matchAll(/https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9+%]+\._AC_(?:SL\d+|)_?\.jpg/g)].map(m => m[0])
    )].filter(u => !/_SS\d|_CR\d|_SR\d|_SX\d|_SY\d|_QL\d|_UX\d|_UL\d/.test(u));
    const allImgs = [...new Set([...hiRes, ...large, ...mainImg, ...dynImg, ...srcSet, ...acImgs])]
      .filter(u => u.includes('media-amazon.com') || u.includes('images-na.ssl-images-amazon'));
    // No cap — take all images the product actually has
    amazonImages = allImgs;

    // While we have the HTML, also scrape the product detail tables for extra specs
    try {
      const extraSpecs = {};
      // Extract rows from productDetails tech spec tables and product overview
      const rowRe = /<tr[^>]*>[\s\S]*?<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/g;
      let rm;
      while ((rm = rowRe.exec(html)) !== null) {
        const k = rm[1].replace(/<[^>]+>/g, '').trim();
        const v = rm[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (k && v && k.length < 60 && v.length < 200) extraSpecs[k] = v;
      }
      // Also extract the "glance_icon_arr" / quick-overview bullets
      const liRe = /class="a-list-item"[^>]*>([\s\S]*?)<\/li>/g;
      const existingSpecs = product.specs || {};
      if (Object.keys(extraSpecs).length > 0) {
        const merged = { ...existingSpecs };
        for (const [k, v] of Object.entries(extraSpecs)) {
          const key = k.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
          if (key && !merged[key]) merged[key] = v;
        }
        await Product.findByIdAndUpdate(product._id, { specs: merged });
        console.log(`fetchAndUploadImages: enriched specs for ${product._id} (+${Object.keys(extraSpecs).length} fields from Amazon)`);
      }

      // Correct isPrime if Keepa missed it — check Amazon page for Prime badge
      if (!product.isPrime && /a-icon-prime|i-prime|prime-logo|primeBadge/i.test(html)) {
        await Product.findByIdAndUpdate(product._id, { isPrime: true });
        console.log(`fetchAndUploadImages: corrected isPrime=true for ${product._id} from Amazon HTML`);
      }
    } catch {}
  } catch {}

  // Final fallback: probe legacy ASIN image URLs and keep only distinct images.
  // Amazon returns HTTP 200 for all indices but repeats the .01 image when a slot is empty.
  // We detect duplicates by comparing Content-Length — different size = real distinct image.
  if (!amazonImages.length) {
    const asinMatch = product.url.match(/\/dp\/([A-Z0-9]{10})/i);
    if (asinMatch) {
      const asin = asinMatch[1];
      const base = `https://images-na.ssl-images-amazon.com/images/P/${asin}`;
      const getSize = async (url) => {
        try {
          const r = await axios.head(url, { timeout: 5000 });
          return parseInt(r.headers['content-length'] || '0', 10);
        } catch { return 0; }
      };
      const size01 = await getSize(`${base}.01.LZZZZZZZ.jpg`);
      if (size01 > 0) {
        amazonImages = [`${base}.01.LZZZZZZZ.jpg`];
        // Probe .02–.12 in parallel; include only those with a different size from .01
        const checks = await Promise.all(
          Array.from({ length: 11 }, (_, i) => {
            const idx = String(i + 2).padStart(2, '0');
            const url = `${base}.${idx}.LZZZZZZZ.jpg`;
            return getSize(url).then(sz => sz > 0 && sz !== size01 ? url : null);
          })
        );
        amazonImages.push(...checks.filter(Boolean));
        console.log(`fetchAndUploadImages: legacy probe found ${amazonImages.length} distinct images for ${asin}`);
      }
    }
  }

  // Last resort: use Keepa images passed in as seed (already accessible CDN URLs)
  if (!amazonImages.length && seedImages.length) {
    amazonImages = [...seedImages];
    console.log(`fetchAndUploadImages: using ${seedImages.length} Keepa seed images for ${product._id}`);
  }

  if (!amazonImages.length) return null;

  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloud || !apiKey || !apiSecret) return null;

  const asin = product.url.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || product._id.toString();
  const slug = `${product._id}-${asin}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
  const folder = `tracker-images/${slug}`;

  // Skip upload only if Cloudinary already has >= as many images as we found on Amazon
  try {
    const existing = await axios.get(
      `https://api.cloudinary.com/v1_1/${cloud}/resources/image?prefix=${encodeURIComponent(folder + '/')}&max_results=50&type=upload`,
      { auth: { username: apiKey, password: apiSecret }, timeout: 8000 }
    );
    const existingUrls = (existing.data.resources || []).map(r => r.secure_url).filter(Boolean);
    if (existingUrls.length >= amazonImages.length && existingUrls.length > 0) {
      console.log(`fetchAndUploadImages: folder ${folder} already has ${existingUrls.length}/${amazonImages.length} images — skipping upload`);
      await Product.findByIdAndUpdate(product._id, { image: existingUrls[0], images: existingUrls, cloudinaryFolder: folder });
      return existingUrls;
    }
    if (existingUrls.length > 0) {
      console.log(`fetchAndUploadImages: folder ${folder} has ${existingUrls.length} but Amazon has ${amazonImages.length} — re-uploading all`);
    }
  } catch {}

  const cloudinaryUrls = [];

  for (let i = 0; i < amazonImages.length; i++) {
    try {
      const fullResUrl = amazonImages[i].replace(/\._[A-Z0-9_]+_(?=\.jpg)/i, '');
      let imgBuffer;
      try {
        ({ data: imgBuffer } = await axios.get(fullResUrl, { responseType: 'arraybuffer', timeout: 15000 }));
      } catch {
        ({ data: imgBuffer } = await axios.get(amazonImages[i], { responseType: 'arraybuffer', timeout: 15000 }));
      }
      const publicId  = `${slug}-${String(i + 1).padStart(2, '0')}`;
      const timestamp = Math.floor(Date.now() / 1000);
      const eager     = 'c_limit,q_auto:best,w_3000';
      const toSign    = `eager=${eager}&folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
      const signature = crypto.createHash('sha1').update(toSign).digest('hex');
      const uploadParams = new URLSearchParams({
        file: `data:image/jpeg;base64,${Buffer.from(imgBuffer).toString('base64')}`,
        api_key: apiKey, timestamp: String(timestamp), signature, folder, public_id: publicId, eager,
      });
      const { data: uploaded } = await axios.post(
        `https://api.cloudinary.com/v1_1/${cloud}/image/upload`,
        uploadParams.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
      );
      cloudinaryUrls.push(uploaded.eager?.[0]?.secure_url || uploaded.secure_url);
    } catch (e) {
      console.error(`fetchAndUploadImages: cloudinary upload failed:`, e.message);
    }
  }

  if (cloudinaryUrls.length) {
    await Product.findByIdAndUpdate(product._id, { image: cloudinaryUrls[0], images: cloudinaryUrls, cloudinaryFolder: folder });
    console.log(`fetchAndUploadImages: saved ${cloudinaryUrls.length} Cloudinary images for ${product._id}`);
  }

  return cloudinaryUrls.length ? cloudinaryUrls : null;
}

// POST re-fetch images for a product — tries Keepa first, falls back to Amazon HTML scrape + Cloudinary upload
router.post("/:id/refresh-images", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    // Step 1: try Keepa (fast, no Cloudinary needed)
    const info = await fetchProduct(product.url, { priceOnly: false, skipVariants: false, forceRefresh: true });
    const images = info.images || [];
    const image  = info.image || images[0] || null;

    if (image) {
      const update = { image, images };
      if (info.specs && Object.keys(info.specs).length) update.specs = info.specs;
      if (info.bullets?.length) update.bullets = info.bullets;
      await Product.findByIdAndUpdate(product._id, update);
      return res.json({ ok: true, source: 'keepa', count: images.length, image, images, specs: update.specs || {}, bullets: update.bullets || [] });
    }

    // Step 2: Amazon scrape + Cloudinary
    const cloudinaryUrls = await fetchAndUploadImages(product);
    if (!cloudinaryUrls) return res.json({ ok: true, source: 'none', count: 0, image: null, images: [] });

    res.json({ ok: true, source: 'amazon+cloudinary', count: cloudinaryUrls.length, image: cloudinaryUrls[0], images: cloudinaryUrls });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// DELETE remove a product — hard delete
router.delete("/:id", async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    // End the eBay listing if one was active
    if (product.ebayListingId) {
      endListing(product.ebayListingId).catch(e => {
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

    await scheduler.checkOne(product);
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

    function calcEbayPrice(ap) {
      const c = ap * 1.085;
      return Math.floor((c + 0.30) / (1 - 0.1325 - 0.05 - 0.07)) + 0.99;
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
        const profit = +(ebay - v.current * 1.085 - fee).toFixed(2);
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
