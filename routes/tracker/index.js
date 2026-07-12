const express = require("express");
const router = express.Router();
const axios = require("axios");
const Product = require("../../models/tracker/Product");

// 10-minute cache for deal search results — each search costs 5 credits
const _dealSearchCache = new Map(); // query → { deals, expiresAt }
const DEAL_CACHE_TTL = 10 * 60 * 1000; // 10 min — conserves Keepa tokens (Deal API costs 5/call)
const TrackerSettings = require("../../models/tracker/TrackerSettings");
const { cleanUrl, extractAsin, fetchProduct } = require("../../scraper");
const scheduler = require("../../jobs/trackerScheduler");
const { deleteCloudinaryFolder } = require("../../utils/cloudinaryUtils");
const { deleteB2Prefix } = require("../../utils/b2Utils");
const { endListing, removeVariation } = require("../../jobs/ebayPriceSync");

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
    res.json({
      title: info.title, price: info.price, currency: info.currency, image: info.image,
      isPrime: info.isPrime || false, upc: info.upc || null, variants, groupId,
      specs: info.specs || {}, bullets: info.bullets || [], images: info.images || [],
      listPrice: info.listPrice ?? null, rating: info.rating ?? null, reviewCount: info.reviewCount ?? 0,
    });
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

// GET search for items with recent price drops using Keepa Deal API, under an optional
// maxPrice (defaults to $15, matches the Deals-tab search; Auction tab passes a lower ceiling).
// Deal API returns up to 150 items per category; price/rating filters applied client-side
// since API-side filters are unreliable. Ratings fetched via a second batch product call.
router.get("/search-deals", async (req, res) => {
  try {
    const category = (req.query.category || "").trim();
    if (!category) return res.status(400).json({ error: "category is required" });
    if (!process.env.KEEPA_API_KEY) return res.status(500).json({ error: "KEEPA_API_KEY not set" });

    const categoryId = KEEPA_CATEGORY_IDS[category];
    if (!categoryId) return res.status(400).json({ error: `Unknown category "${category}". Must be one of: ${Object.keys(KEEPA_CATEGORY_IDS).join(', ')}` });

    const maxPrice = Number(req.query.maxPrice) > 0 ? Number(req.query.maxPrice) : 15;
    const singleOnly = req.query.singleOnly === 'true';
    const cacheKey = `${category.toLowerCase()}:${maxPrice}:${singleOnly}`;
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

    // Step 2: client-side filter — keep only items priced ≤ maxPrice
    const candidates = drItems.filter(d => {
      const p = dealPrice(d.current);
      return p !== null && p <= maxPrice;
    }).slice(0, 50);

    if (!candidates.length) {
      console.log(`search-deals "${category}": dr=${drItems.length} — no items under $${maxPrice}`);
      return res.json({ category, deals: [] });
    }

    // Step 3: batch-fetch product data to get ratings (not included in Deal response)
    const asinList = [...new Set(candidates.map(d => d.asin))];
    const { data: pData } = await axios.get("https://api.keepa.com/product", {
      params: { key: keepaKey, asin: asinList.join(","), domain: 1, stats: 0, history: 0 },
      timeout: 60000,
    });
    if (pData.tokensLeft != null) console.log(`search-deals: tokensLeft=${pData.tokensLeft}`);

    const ratingMap = {}, reviewMap = {}, soldMap = {}, hasVariantsMap = {};
    for (const p of (pData.products || [])) {
      ratingMap[p.asin] = p.rating > 0 ? p.rating / 10 : null;
      reviewMap[p.asin] = p.countReviews || 0;
      soldMap[p.asin]   = p.monthlySold > 0 ? p.monthlySold : null;
      // Keepa sets parentAsin on any ASIN that's a child of a variation family (color/size/etc.
      // siblings) — null means this exact ASIN is a standalone, single-variant listing.
      hasVariantsMap[p.asin] = !!p.parentAsin;
    }

    // Step 4: apply 4+ star filter and build the response shape the frontend expects. singleOnly
    // sorts single-item listings first rather than excluding variation-family items outright —
    // a hard exclude compounds too badly with a low maxPrice (cheap price-drop deals are already
    // rare, and most cheap products *do* have color/size variants), leaving many categories with
    // zero results. hasVariants is exposed either way so the frontend can show a badge.
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
          hasVariants:     hasVariantsMap[d.asin] || false,
        };
      })
      .sort((a, b) => {
        if (singleOnly && a.hasVariants !== b.hasVariants) return a.hasVariants ? 1 : -1;
        return (b.discountPercent || 0) - (a.discountPercent || 0);
      });

    console.log(`search-deals "${category}": dr=${drItems.length} under$${maxPrice}=${candidates.length} passed=${deals.length}`);
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
    if (existing) return res.status(409).json({ error: "Already tracking this product.", product: existing });

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

    // Queue Cloudinary upload — serialized to prevent concurrent Amazon scrapes triggering bot detection
    queueImageUpload(product, info.images || []).catch(e => console.error(`auto-image: failed for ${product._id}:`, e.message));
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
    const { ebayListingId, cloudinaryFolder, ebayPrice, listingType } = req.body;
    const update = { ebayListingId: ebayListingId || null, listedAt: ebayListingId ? new Date() : null };
    if (cloudinaryFolder !== undefined) update.cloudinaryFolder = cloudinaryFolder || null;
    if (ebayPrice !== undefined) update.ebayPrice = ebayPrice != null ? Number(ebayPrice) : null;
    if (listingType !== undefined) update.listingType = listingType || null;
    const product = await Product.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Shared helper: scrape Amazon for images and upload to Cloudinary.
// Called automatically on product add (background) and from refresh-images route.
// Browser header presets — rotate between attempts so Amazon sees different clients
const BROWSER_HEADERS = [
  // Attempt 1: Desktop Chrome (best for embedded colorImages JSON)
  {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'max-age=0',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Chromium";v="124","Google Chrome";v="124","Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  },
  // Attempt 2: Mobile Safari (different rendering path, sometimes less blocked)
  {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Upgrade-Insecure-Requests': '1',
  },
];

// Scrape all structured product data from an Amazon HTML page.
// Returns { bullets, specs, description } to enrich the DB record.
function extractAmazonProductData(html) {
  const stripTags = s => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').trim();

  const result = { bullets: [], specs: {}, description: '' };
  const addSpec = (rawKey, rawVal) => {
    const k = stripTags(rawKey).replace(/:$/, '').trim();
    const v = stripTags(rawVal).trim();
    if (!k || !v || k.length > 80 || v.length > 400) return;
    const key = k.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const SKIP = new Set(['customer_reviews','bestsellers_rank','best_sellers_rank','asin_','date_first','feedback']);
    if (key && key.length > 1 && ![...SKIP].some(s => key.startsWith(s))) result.specs[key] = v;
  };

  // ── 1. Feature bullets ("About this item") ───────────────────────────────
  const featureBulletsBlock = html.match(/id="feature-bullets"[\s\S]*?<\/div>/);
  if (featureBulletsBlock) {
    for (const m of featureBulletsBlock[0].matchAll(/<span[^>]*class="[^"]*a-list-item[^"]*"[^>]*>([\s\S]*?)<\/span>/g)) {
      const text = stripTags(m[1]);
      if (text.length > 15 && text.length < 600 && !/^\s*$/.test(text)) result.bullets.push(text);
    }
  }

  // ── 2. Table-format specs: <th>key</th><td>value</td> ────────────────────
  for (const m of html.matchAll(/<tr[^>]*>[\s\S]*?<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/g)) {
    addSpec(m[1], m[2]);
  }

  // ── 3. Detail-bullet list: <span class="a-text-bold">Key:</span> Value ───
  for (const m of html.matchAll(/<span[^>]*class="[^"]*a-text-bold[^"]*"[^>]*>([\s\S]*?)<\/span>[\s\S]{0,30}<span[^>]*>([\s\S]*?)<\/span>/g)) {
    addSpec(m[1], m[2]);
  }

  // ── 4. productDetails dl-style: <div class="a-section"><label>…</label><div>…</div> ──
  for (const m of html.matchAll(/<th[^>]*class="[^"]*prodDetSectionEntry[^"]*"[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*class="[^"]*prodDetAttrValue[^"]*"[^>]*>([\s\S]*?)<\/td>/g)) {
    addSpec(m[1], m[2]);
  }

  // ── 5. Product description text ───────────────────────────────────────────
  const descBlock = html.match(/id="productDescription"[^>]*>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/);
  if (descBlock) {
    const text = stripTags(descBlock[1]);
    if (text.length > 30) result.description = text.slice(0, 1500);
  }
  // Fallback: A+ content description
  if (!result.description) {
    const aplusBlock = html.match(/class="[^"]*aplus-v2[^"]*"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
    if (aplusBlock) {
      const text = stripTags(aplusBlock[1]);
      if (text.length > 30) result.description = text.slice(0, 1500);
    }
  }

  // Deduplicate bullets
  result.bullets = [...new Set(result.bullets)].slice(0, 12);
  return result;
}

// Extract the full colorImages map from Amazon's HTML using brace-counting.
// Amazon embeds ALL color variants' galleries in one page — returns normalizedKey → [urls].
// The 'initial' key holds images for the currently-selected color.
function extractColorImagesMap(html) {
  const CDN = /(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com)\/images\/I\//;
  const clean = u => u.replace(/\\u002F/g, '/').replace(/\\/g, '');

  const keyIdx = html.indexOf("'colorImages'");
  if (keyIdx === -1) return {};
  let braceStart = -1;
  for (let i = keyIdx + 13; i < Math.min(html.length, keyIdx + 100); i++) {
    if (html[i] === '{') { braceStart = i; break; }
  }
  if (braceStart === -1) return {};

  // Walk braces to find the matching closing brace for the colorImages object
  let depth = 0, end = braceStart;
  for (let i = braceStart; i < Math.min(html.length, braceStart + 500000); i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const raw = html.slice(braceStart, end + 1);
  const result = {};

  // Extract each color key's image array using bracket counting
  const keyRe = /'([^']+)'\s*:\s*\[/g;
  let km;
  while ((km = keyRe.exec(raw)) !== null) {
    const colorKey = km[1].toLowerCase().replace(/\s+/g, ' ').trim();
    const arrStart = km.index + km[0].length - 1;
    let arrDepth = 0, arrEnd = arrStart;
    for (let i = arrStart; i < raw.length; i++) {
      if (raw[i] === '[') arrDepth++;
      else if (raw[i] === ']') { arrDepth--; if (arrDepth === 0) { arrEnd = i; break; } }
    }
    const arr = raw.slice(arrStart, arrEnd + 1);
    const us = new Set();
    for (const m of arr.matchAll(/"(?:hiRes|large)"\s*:\s*"(https:\/\/[^"]+)"/g)) {
      const u = clean(m[1]); if (CDN.test(u)) us.add(u);
    }
    for (const m of arr.matchAll(/"(https:\/\/[^"]+\._AC_[A-Z0-9_,]+\.jpg[^"]*)"/g)) {
      const u = clean(m[1]);
      if (CDN.test(u) && !/_SS\d|_SR\d|_CR\d|thumb/i.test(u)) us.add(u);
    }
    if (us.size > 0) result[colorKey] = [...us];
  }
  return result;
}

// Match a variant label to the best key in a colorImages map
function matchColorKey(colorMap, variantLabel) {
  if (!variantLabel || !Object.keys(colorMap).length) return null;
  const norm = variantLabel.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  if (colorMap[norm]) return colorMap[norm];
  for (const [key, urls] of Object.entries(colorMap)) {
    if (key === 'initial') continue;
    if (norm.includes(key) || key.includes(norm)) return urls;
  }
  const nw = norm.split(' ').filter(w => w.length > 2);
  let best = null, bestScore = 0;
  for (const [key, urls] of Object.entries(colorMap)) {
    if (key === 'initial') continue;
    const kw = key.split(' ').filter(w => w.length > 2);
    const overlap = kw.filter(w => nw.includes(w)).length;
    const score = overlap / Math.max(kw.length, nw.length, 1);
    if (score > bestScore && score >= 0.4) { bestScore = score; best = urls; }
  }
  return best;
}

function extractAmazonImages(html) {
  const CDN = /(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com)\/images\/I\//;
  const clean = u => u.replace(/\\u002F/g, '/').replace(/\\/g, '');
  const urls = new Set();

  // 1. colorImages JSON — use brace-counting map extraction (robust against apostrophes and
  //    nested objects; replaces brittle [^}]* regex that failed on complex colorImages objects)
  const colorMap = extractColorImagesMap(html);
  if (colorMap.initial?.length) {
    for (const u of colorMap.initial) urls.add(u);
  }

  // 2. data-a-dynamic-image attr — JSON map of url→[w,h], present on main img element
  for (const m of html.matchAll(/data-a-dynamic-image="([^"]+)"/g)) {
    try {
      const obj = JSON.parse(m[1].replace(/&quot;/g, '"'));
      Object.keys(obj).forEach(u => urls.add(u));
    } catch {}
  }

  // 3. Embedded hiRes / large / dynamic_image_url JSON strings
  for (const m of html.matchAll(/"(?:hiRes|large|dynamic_image_url)"\s*:\s*"(https:\/\/[^"]+)"/g)) {
    urls.add(clean(m[1]));
  }

  // 4. ImageBlock script data (desktop page)
  for (const m of html.matchAll(/"(?:mainUrl|hiResUrl|thumbnailUrl)"\s*:\s*"(https:\/\/[^"]+)"/g)) {
    const u = clean(m[1]);
    if (!/_SS\d|_SR\d|_SX\d|thumb/i.test(u)) urls.add(u);
  }

  // 5. _AC_SL1500_ pattern from any context (mobile page fallback)
  for (const m of html.matchAll(/https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9+%]+\._AC_(?:SL\d+_?)?\.jpg/g)) {
    if (!/_SS\d|_CR\d|_SR\d|_SX\d|_SY\d|_QL\d|_UX\d|_UL\d/.test(m[0])) urls.add(m[0]);
  }

  // 6. landingImage / imgBlkFront src as last resort
  for (const m of html.matchAll(/(?:id="landingImage"|id="imgBlkFront")[^>]+src="([^"]+)"/g)) urls.add(m[1]);

  return [...urls].filter(u => CDN.test(u));
}

// Fetch an Amazon product page via ScraperAPI autoparse=true.
// Returns structured JSON: { name, images, highResImages, feature_bullets,
// product_information, full_description, customization_options }.
// autoparse is not blocked by Amazon and costs 1 credit on the free plan.
async function scraperApiAutoparse(amazonUrl) {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) return null;
  try {
    const { data } = await axios.get('http://api.scraperapi.com/', {
      params: { api_key: key, url: amazonUrl, autoparse: 'true' },
      timeout: 60000,
    });
    if (data && (data.name || data.images)) return data;
    return null;
  } catch (e) {
    console.warn(`scraperApiAutoparse failed for ${amazonUrl}: ${e.message}`);
    return null;
  }
}

// Amazon sometimes cross-links closely related listings (e.g. a single-pack and a multi-pack
// of the same product), and ScraperAPI's scrape of one can non-deterministically fold in the
// other's hero/first gallery photo. Track each ASIN's own hero image ID as we see it, so a
// later scrape can strip out any image that's actually a DIFFERENT ASIN's registered hero —
// the shared lifestyle/feature photos in the middle of the gallery are untouched since those
// never occupy position 0 for any product.
const heroImageRegistry = new Map(); // amazon image id -> asin it belongs to

function amazonImageId(url) {
  return String(url).match(/\/images\/I\/([^._/]+)/)?.[1] || null;
}

// Bridges the pre-flight hero pass to the real fetch-and-upload pass for the same product,
// so a group scrape doesn't pay for ScraperAPI twice per sibling. Short TTL — only needs to
// survive the few seconds between the two passes within one "Fix Photos" click.
const scrapedPageCache = new Map(); // product id string -> { parsed, expiresAt }
const SCRAPED_PAGE_TTL = 3 * 60 * 1000;

async function getParsedPage(product) {
  const key = product._id.toString();
  const cached = scrapedPageCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    scrapedPageCache.delete(key);
    return cached.parsed;
  }
  return scraperApiAutoparse(product.url);
}

// Registers every sibling's hero image BEFORE any of them go through the real
// scrape-and-upload pass, so the cross-sibling filter has full knowledge from the start —
// otherwise whichever sibling gets scraped first in a brand-new group has nothing to filter
// against yet. Caches each sibling's parsed page so the real pass (getParsedPage) reuses it
// instead of scraping again.
async function preflightRegisterGroupHeroes(groupId) {
  if (!groupId) return 0;
  const siblings = await Product.find({ groupId }).select('_id url').lean();
  let registered = 0;
  for (const sib of siblings) {
    const asin = sib.url.match(/\/dp\/([A-Z0-9]{10})/i)?.[1];
    if (!asin) continue;
    try {
      const parsed = await scraperApiAutoparse(sib.url);
      if (!parsed) continue;
      const forceHiRes = u => String(u).replace(/\._AC_(?:US\d+|SX\d+|SY\d+|SS\d+)?_?(?=\.jpg)/i, '._AC_SL1500_');
      const hiRes = (parsed.highResImages || [])
        .map(img => forceHiRes(typeof img === 'string' ? img : (img.link || img.url || '')))
        .filter(u => u.includes('media-amazon') || u.includes('ssl-images-amazon'));
      const heroId = hiRes.length ? amazonImageId(hiRes[0]) : null;
      if (heroId) {
        heroImageRegistry.set(heroId, asin);
        await Product.findByIdAndUpdate(sib._id, { heroImageId: heroId });
        registered++;
      }
      scrapedPageCache.set(sib._id.toString(), { parsed, expiresAt: Date.now() + SCRAPED_PAGE_TTL });
    } catch (e) {
      console.warn(`preflightRegisterGroupHeroes: failed for ${sib._id}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 800)); // stay gentle on Amazon, matches sequential-scrape convention elsewhere
  }
  console.log(`preflightRegisterGroupHeroes: registered ${registered}/${siblings.length} heroes for group ${groupId}`);
  return registered;
}

async function fetchAndUploadImages(product, seedImages = [], { forceUpload = false, skipSiblings = false } = {}) {
  let amazonImages = [];
  const productAsin = product.url.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;

  // If seedImages are pre-extracted Amazon CDN image URLs (from colorImages sibling seeding),
  // skip the ScraperAPI page fetch entirely — saves 10 credits per sibling.
  // Seeds qualify when they have 3+ real image URLs (not GIF placeholders).
  const CDN_RE = /(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com)\/images\/I\//;
  const realSeeds = seedImages.filter(u => CDN_RE.test(u));
  if (!forceUpload && realSeeds.length >= 3) {
    console.log(`fetchAndUploadImages: using ${realSeeds.length} pre-extracted seeds for ${product._id} — skipping ScraperAPI`);
    amazonImages = realSeeds;
  }

  if (!amazonImages.length) {
    // ── Path A: ScraperAPI autoparse (structured JSON, not blocked by Amazon) ──
    // Reuses a pre-flight scrape (see preflightRegisterGroupHeroes) if one was cached
    // for this product, instead of hitting ScraperAPI a second time.
    const parsed = await getParsedPage(product);
    if (parsed) {
      const forceHiRes = u => String(u).replace(/\._AC_(?:US\d+|SX\d+|SY\d+|SS\d+)?_?(?=\.jpg)/i, '._AC_SL1500_');
      let hiRes = (parsed.highResImages || [])
        .map(img => forceHiRes(typeof img === 'string' ? img : (img.link || img.url || '')))
        .filter(u => u.includes('media-amazon') || u.includes('ssl-images-amazon'));

      if (hiRes.length && productAsin) {
        const heroId = amazonImageId(hiRes[0]);
        if (heroId) heroImageRegistry.set(heroId, productAsin);

        // Pull in sibling group members' persisted hero IDs too — the in-memory registry
        // alone only protects whichever sibling gets scraped SECOND in a given process
        // lifetime. Checking the DB makes the filter symmetric and restart-proof: as long
        // as a sibling has been scraped at least once before, its hero is known up front.
        if (product.groupId) {
          try {
            const siblings = await Product.find({ groupId: product.groupId, _id: { $ne: product._id }, heroImageId: { $ne: null } })
              .select('heroImageId url').lean();
            for (const sib of siblings) {
              const sibAsin = sib.url.match(/\/dp\/([A-Z0-9]{10})/i)?.[1];
              if (sib.heroImageId && sibAsin && !heroImageRegistry.has(sib.heroImageId)) {
                heroImageRegistry.set(sib.heroImageId, sibAsin);
              }
            }
          } catch {}
        }

        hiRes = hiRes.filter((u, i) => {
          if (i === 0) return true; // never drop this product's own hero
          const id = amazonImageId(u);
          const owner = id ? heroImageRegistry.get(id) : null;
          if (owner && owner !== productAsin) {
            console.log(`fetchAndUploadImages: dropping cross-linked hero image (belongs to ${owner}) from ${productAsin}'s scrape`);
            return false;
          }
          return true;
        });

        if (heroId) {
          Product.findByIdAndUpdate(product._id, { heroImageId: heroId }).catch(() => {});
        }
      }

      const selectedVariant = (parsed.customization_options?.Color || []).find(c => c.is_selected);
      const swatch = selectedVariant?.image ? forceHiRes(selectedVariant.image) : null;
      amazonImages = swatch ? [swatch, ...hiRes] : hiRes;

      if (amazonImages.length) {
        console.log(`fetchAndUploadImages: autoparse got ${amazonImages.length} images for ${product._id}`);

        // Save bullets, specs, description from structured response
        try {
          const bullets = (parsed.feature_bullets || []).map(b => String(b).trim()).filter(b => b.length > 15).slice(0, 12);
          const specs = {};
          const SKIP = new Set(['best_sellers_rank','customer_reviews','asin']);
          for (const [k, v] of Object.entries(parsed.product_information || {})) {
            if (typeof v === 'string' && v.trim()) {
              const key = k.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
              if (key && key.length > 1 && !SKIP.has(key)) specs[key] = v.trim();
            }
          }
          const update = {};
          if (bullets.length > (product.bullets?.length || 0)) update.bullets = bullets;
          if (Object.keys(specs).length) {
            const merged = { ...(product.specs || {}) };
            for (const [k, v] of Object.entries(specs)) { if (!merged[k]) merged[k] = v; }
            update.specs = merged;
          }
          if (parsed.full_description && !(product.specs?.description)) {
            update.specs = { ...(update.specs || product.specs || {}), description: String(parsed.full_description).slice(0, 1500) };
          }
          if (Object.keys(update).length) await Product.findByIdAndUpdate(product._id, update);
        } catch {}

        // Seed siblings: customization_options has every variant's swatch + same hiRes shots.
        // Skip during auto-list (skipSiblings=true) — the frontend already calls refresh-images
        // for every variant sequentially, so sibling seeding would cause redundant uploads.
        if (!skipSiblings && product.groupId && (parsed.customization_options?.Color?.length || 0) > 1) {
          Product.find({ groupId: product.groupId, _id: { $ne: product._id } }).lean().then(siblings => {
            siblings = siblings.filter(s => !s.images?.some(u => u.includes('cloudinary')));
            for (const sib of siblings) {
              const norm = (sib.variant || '').toLowerCase().replace(/[^a-z0-9]/g,' ').trim();
              const match = parsed.customization_options.Color.find(c => {
                const cv = (c.value || '').toLowerCase().replace(/[^a-z0-9]/g,' ').trim();
                return cv === norm || cv.includes(norm) || norm.includes(cv);
              });
              const sibSwatch = match?.image ? forceHiRes(match.image) : null;
              const sibImages = sibSwatch ? [sibSwatch, ...hiRes] : hiRes;
              if (sibImages.length >= 2) {
                console.log(`autoparse: seeding "${sib.variant}" with ${sibImages.length} images`);
                queueImageUpload(sib, sibImages).catch(() => {});
              }
            }
          }).catch(() => {});
        }
      }
    }

    // ── Path B: direct Amazon HTML scrape (fallback when no ScraperAPI key) ──
    if (!amazonImages.length) {
    for (const headers of BROWSER_HEADERS) {
      try {
        const { data: html } = await axios.get(product.url, { timeout: 18000, headers, decompress: true });
        if (/robot|captcha|sign-in|ap\/signin|validateCaptcha/i.test(html.slice(0, 3000))) {
          console.log(`fetchAndUploadImages: Amazon blocked for ${product._id}`);
          continue;
        }
        const imgs = extractAmazonImages(html);
        if (imgs.length > 0) {
          amazonImages = imgs;
          const colorMap = extractColorImagesMap(html);
          const variantGallery = matchColorKey(colorMap, product.variant);
          if (variantGallery && variantGallery.length > amazonImages.length) amazonImages = variantGallery;
          if (!skipSiblings && product.groupId && Object.keys(colorMap).length > 1) {
            Product.find({ groupId: product.groupId, _id: { $ne: product._id } }).lean().then(siblings => {
              siblings = siblings.filter(s => !s.images?.some(u => u.includes('cloudinary')));
              for (const sib of siblings) {
                const sibGallery = matchColorKey(colorMap, sib.variant);
                if (sibGallery?.length) queueImageUpload(sib, sibGallery).catch(() => {});
              }
            }).catch(() => {});
          }
          try {
            const amazonData = extractAmazonProductData(html);
            const update = {};
            if (amazonData.bullets.length > (product.bullets?.length || 0)) update.bullets = amazonData.bullets;
            if (Object.keys(amazonData.specs).length) {
              const merged = { ...(product.specs || {}) };
              for (const [k, v] of Object.entries(amazonData.specs)) { if (!merged[k]) merged[k] = v; }
              update.specs = merged;
            }
            if (amazonData.description && !(product.specs?.description)) {
              update.specs = { ...(update.specs || product.specs || {}), description: amazonData.description };
            }
            if (!product.isPrime && /a-icon-prime|i-prime|prime-logo|primeBadge/i.test(html)) update.isPrime = true;
            if (Object.keys(update).length) await Product.findByIdAndUpdate(product._id, update);
          } catch {}
          console.log(`fetchAndUploadImages: HTML scrape got ${amazonImages.length} images for ${product._id}`);
          break;
        }
      } catch (e) {
        console.log(`fetchAndUploadImages: request failed for ${product._id}: ${e.message}`);
      }
    }
    } // end Path B
  } // end if (!amazonImages.length)


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

  // Dedupe by URL — the color swatch is frequently the same shot as the first
  // gallery image, and without this each duplicate gets uploaded as its own
  // distinct B2 file (so a later Set-based dedup on the uploaded URLs can't catch it).
  amazonImages = [...new Set(amazonImages)];

  const { b2Enabled, uploadToB2, listB2Files } = require('../../utils/b2Utils');

  const asin = product.url.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || product._id.toString();
  const slug = `${product._id}-${asin}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
  const folder = `tracker-images/${slug}`;

  if (b2Enabled()) {
    // ── B2 path ──────────────────────────────────────────────────────
    let existingUrls = [];
    try {
      existingUrls = await listB2Files(folder + '/');
      if (existingUrls.length === amazonImages.length && existingUrls.length > 0) {
        console.log(`fetchAndUploadImages: B2 folder ${folder} already has ${existingUrls.length} images matching the scrape count — skipping`);
        await Product.findByIdAndUpdate(product._id, { image: existingUrls[0], images: existingUrls, cloudinaryFolder: folder });
        return existingUrls;
      }
    } catch {}

    // Counts don't match (stale/corrupted folder from a prior scrape, or first upload) —
    // wipe and re-upload the full fresh set rather than resuming from existingUrls.length,
    // which assumed the old files were always a valid prefix of the new list. That assumption
    // breaks whenever the old folder over-scraped (e.g. duplicate images) and the fresh scrape
    // finds fewer real photos than before — resuming would silently keep the stale extras forever.
    if (existingUrls.length > 0) {
      console.log(`fetchAndUploadImages: B2 folder ${folder} has ${existingUrls.length} images but scrape found ${amazonImages.length} — replacing`);
      await deleteB2Prefix(folder + '/');
    }

    const b2Urls = [];

    for (let i = 0; i < amazonImages.length; i++) {
      try {
        const fullResUrl = amazonImages[i].replace(/\._[A-Z0-9_]+_(?=\.jpg)/i, '');
        let imgBuffer;
        try {
          ({ data: imgBuffer } = await axios.get(fullResUrl, { responseType: 'arraybuffer', timeout: 15000 }));
        } catch {
          ({ data: imgBuffer } = await axios.get(amazonImages[i], { responseType: 'arraybuffer', timeout: 15000 }));
        }
        const buf = Buffer.from(imgBuffer);
        if (buf.length < 500 || (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)) {
          console.log(`fetchAndUploadImages: skipping GIF/tiny placeholder (${buf.length}b) for image ${i + 1}`);
          continue;
        }
        const fileKey = `${folder}/${slug}-${String(i + 1).padStart(2, '0')}.jpg`;
        const b2Url = await uploadToB2(buf, fileKey, 'image/jpeg');
        b2Urls.push(b2Url);
      } catch (e) {
        console.error(`fetchAndUploadImages: B2 upload failed for image ${i + 1}:`, e.message);
      }
    }

    if (b2Urls.length) {
      await Product.findByIdAndUpdate(product._id, { image: b2Urls[0], images: b2Urls, cloudinaryFolder: folder });
      console.log(`fetchAndUploadImages: saved ${b2Urls.length} B2 images for ${product._id}`);
    }

    return b2Urls.length ? b2Urls : null;
  }

  return null;
}

// Serialize background image uploads so concurrent variant tracking doesn't hammer Amazon
// simultaneously and trigger bot detection. One upload at a time, 3s gap between them.
const _imageUploadQueue = [];
let _imageUploadRunning = false;

// Track which product IDs are already in the queue to avoid duplicate entries.
// For large multi-variant products, sibling seeding creates O(n²) queue entries
// without deduplication (11 variants × 10 seeds each = 110 entries, 99 wasteful).
const _imageUploadQueued = new Set();

async function queueImageUpload(product, seedImages = []) {
  const id = String(product._id);
  if (_imageUploadQueued.has(id)) return; // already queued — skip duplicate
  _imageUploadQueued.add(id);
  return new Promise((resolve) => {
    _imageUploadQueue.push({ product, seedImages, resolve, id });
    if (!_imageUploadRunning) _drainImageQueue();
  });
}

async function _drainImageQueue() {
  if (_imageUploadRunning) return;
  _imageUploadRunning = true;
  while (_imageUploadQueue.length > 0) {
    const { product, seedImages, resolve, id } = _imageUploadQueue.shift();
    if (id) _imageUploadQueued.delete(id); // allow re-queuing after processing
    try {
      resolve(await fetchAndUploadImages(product, seedImages));
    } catch (e) {
      console.error(`imageUploadQueue: failed for ${product._id}:`, e.message);
      resolve(null);
    }
    if (_imageUploadQueue.length > 0) await new Promise(r => setTimeout(r, 3000));
  }
  _imageUploadRunning = false;
}

// POST pre-flight: register every sibling's hero image in a group BEFORE the real
// per-variant refresh-images calls run, so the cross-sibling contamination filter has
// full knowledge from the first click instead of only protecting siblings scraped later
// in the batch. Call this once per group, before looping refresh-images over its variants.
router.post("/group/:groupId/preflight-images", async (req, res) => {
  try {
    const registered = await preflightRegisterGroupHeroes(req.params.groupId);
    res.json({ ok: true, registered });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST re-fetch images for a product — tries Keepa first, falls back to Amazon HTML scrape + Cloudinary upload
router.post("/:id/refresh-images", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    // Step 1: try Keepa (fast, no Cloudinary needed)
    const info = await fetchProduct(product.url, { priceOnly: false, skipVariants: false, forceRefresh: true });
    const images = info.images || [];
    const image  = info.image || images[0] || null;

    // Save specs/bullets from Keepa — but only overwrite images if product has
    // no hosted images yet (avoid clobbering good B2/Cloudinary URLs with Keepa CDN swatches)
    const hasHostedImages = product.images?.some(u => u.includes('cloudinary') || u.includes('backblazeb2.com'));
    if (image) {
      const update = {};
      if (!hasHostedImages) { update.image = image; update.images = images; }
      if (info.specs && Object.keys(info.specs).length) update.specs = info.specs;
      if (info.bullets?.length) update.bullets = info.bullets;
      if (Object.keys(update).length) await Product.findByIdAndUpdate(product._id, update);
    }

    // Step 2: Amazon HTML scrape + upload — always run so we get the full
    // per-variant gallery (6-12 images). Keepa only gives 1 swatch per child ASIN;
    // the Amazon page has all the colour-specific product photos.
    const uploadedUrls = await fetchAndUploadImages(product, images, { forceUpload: true, skipSiblings: true });
    if (uploadedUrls?.length) {
      return res.json({ ok: true, source: 'amazon+storage', count: uploadedUrls.length, image: uploadedUrls[0], images: uploadedUrls, specs: info.specs || {}, bullets: info.bullets || [] });
    }

    // Keepa-only fallback if Amazon scrape found nothing new
    const currentProduct = await Product.findById(product._id).lean();
    const finalImage = currentProduct?.image || image;
    const finalImages = currentProduct?.images?.length ? currentProduct.images : images;
    if (finalImage) {
      return res.json({ ok: true, source: 'keepa', count: finalImages.length, image: finalImage, images: finalImages, specs: info.specs || {}, bullets: info.bullets || [] });
    }

    res.json({ ok: true, source: 'none', count: 0, image: null, images: [] });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Ends the eBay listing (or removes just this variation, if siblings remain) and then
// hard-deletes the product — in that order, so a failed eBay call never leaves a listing
// orphaned live on eBay with no tracker record pointing at it. Shared by the single-delete
// route and the batched group-delete route below.
async function deleteProductAndListing(product) {
  if (product.ebayListingId) {
    const remainingWithListing = await Product.countDocuments({ ebayListingId: product.ebayListingId, _id: { $ne: product._id } });
    // eBay sometimes closes listings before we do (expiry, policy). Treat those as success.
    const isAlreadyEnded = e => /already been closed|not allowed to revise ended|listing has ended|does not exist/i.test(e.message || '');
    try {
      if (remainingWithListing === 0) {
        await endListing(product.ebayListingId);
      } else if (product.variant) {
        await removeVariation(product.ebayListingId, product.variant);
      }
    } catch (e) {
      if (!isAlreadyEnded(e)) {
        return { success: false, error: `Could not update eBay listing ${product.ebayListingId}: ${e.message}. Nothing was deleted — try again.` };
      }
    }
  }

  await Product.findByIdAndDelete(product._id);

  // Delete stored images (both Cloudinary and B2 if migrated)
  if (product.cloudinaryFolder) {
    deleteCloudinaryFolder(product.cloudinaryFolder).catch(() => {});
    deleteB2Prefix(product.cloudinaryFolder + '/').catch(() => {});
  }
  // Also delete tracker-images/ folder — separate from cloudinaryFolder which
  // gets overwritten with the ebay-listings path after listing is created.
  const asin = (product.url || '').match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || product._id.toString();
  const trackerSlug = `${product._id}-${asin}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
  const trackerFolder = `tracker-images/${trackerSlug}`;
  if (trackerFolder !== product.cloudinaryFolder) {
    deleteCloudinaryFolder(trackerFolder).catch(() => {});
    deleteB2Prefix(trackerFolder + '/').catch(() => {});
  }
  return { success: true };
}

// DELETE remove a product — hard delete
router.delete("/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    const result = await deleteProductAndListing(product);
    if (!result.success) return res.status(502).json({ error: result.error });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST bulk-delete a whole group (all variants) in a single request — runs entirely
// server-side so it completes even if the client navigates away, closes the tab, or
// loses connection right after firing it. The old approach (N sequential client-driven
// DELETE calls, one per variant) left every not-yet-called variant permanently stuck if
// the browser was interrupted mid-loop — the bigger the variant group, the longer that
// exposure window. A single request has no client-side loop left to interrupt.
router.post("/group-delete", async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: "ids array is required" });

    const results = [];
    for (const id of ids) {
      try {
        const product = await Product.findById(id);
        if (!product) { results.push({ id, success: false, error: "Product not found" }); continue; }
        const result = await deleteProductAndListing(product);
        results.push({ id, ...result });
      } catch (e) {
        results.push({ id, success: false, error: e.message });
      }
    }
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST manually trigger Cloudinary orphan cleanup now
router.post("/cloudinary-cleanup", async (req, res) => {
  try {
    await scheduler.cloudinaryCleanup();
    res.json({ ok: true });
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

// GET a single tracked product — used to poll for the background image-upload queue (see
// queueImageUpload) finishing after POST / returns, without triggering a second concurrent
// scrape. Registered after every other literal-path GET route in this file (/search-deals,
// /status, /profit-summary, etc.) — Express matches routes top-down, and :id would otherwise
// swallow any of those as an id value.
router.get("/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST test B2 migration for a single product — uploads images to B2, returns URLs
// Does NOT touch the product's DB record or the live Cloudinary pipeline.
router.post("/:id/test-b2", async (req, res) => {
  try {
    const { uploadToB2, b2Enabled } = require('../../utils/b2Utils');
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ error: 'Product not found' });

    // Use existing Cloudinary images as source (already on CDN, no re-scrape needed)
    const sourceUrls = (product.images || []).filter(Boolean).slice(0, 8);
    if (!sourceUrls.length) return res.status(400).json({ error: 'Product has no images to migrate' });

    const asin = (product.url || '').match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || product._id.toString();
    const slug = `${product._id}-${asin}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
    const folder = `tracker-images/${slug}`;

    const b2Urls = [];
    for (let i = 0; i < sourceUrls.length; i++) {
      const url = sourceUrls[i];
      try {
        const { data: imgBuffer } = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        const buf = Buffer.from(imgBuffer);
        if (buf.length < 500) { console.log(`test-b2: skipping tiny file ${i+1}`); continue; }
        const fileKey = `${folder}/${slug}-${String(i + 1).padStart(2, '0')}.jpg`;
        const b2Url = await uploadToB2(buf, fileKey, 'image/jpeg');
        b2Urls.push(b2Url);
        console.log(`test-b2: uploaded image ${i+1}/${sourceUrls.length} → ${b2Url}`);
      } catch (e) {
        console.error(`test-b2: failed image ${i+1}:`, e.message);
      }
    }

    res.json({
      ok: true,
      productId: product._id,
      title: (product.title || '').slice(0, 60),
      source: 'cloudinary',
      uploaded: b2Urls.length,
      total: sourceUrls.length,
      b2Urls,
      sampleUrl: b2Urls[0] || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// On startup, queue repair for products that never got Cloudinary images (e.g. were blocked
// by Amazon bot detection when first tracked). Runs 45s after server start to let it settle.
setTimeout(async () => {
  try {
    const broken = await Product.find({
      $or: [{ cloudinaryFolder: null }, { cloudinaryFolder: { $exists: false } }],
      status: { $nin: ['archived'] },
    }).sort({ createdAt: -1 }).limit(15).lean();
    if (!broken.length) return;
    console.log(`image-repair: queuing ${broken.length} products without Cloudinary images`);
    for (const p of broken) await queueImageUpload(p, p.images || []);
  } catch (e) {
    console.error('image-repair startup:', e.message);
  }
}, 45000);

module.exports = router;
