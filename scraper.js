const axios = require("axios");

// ── ScraperAPI constants ────────────────────────────────────────────────────
const SCRAPER_API_BASE = "https://api.scraperapi.com/";

// ── URL helpers ──────────────────────────────────────────────────────────────
function cleanUrl(url) {
  const full = url.startsWith('http') ? url : `https://${url}`;
  const match = full.match(/(https?:\/\/[a-z.]*amazon\.[a-z.]+\/(?:[^/]+\/)?dp\/[A-Z0-9]{10})/i);
  return match ? match[1] : full;
}

function extractAsin(url) {
  const match = url.match(/\/dp\/([A-Z0-9]{10})/i);
  return match ? match[1] : null;
}

function parsePrice(str) {
  if (str == null) return null;
  if (typeof str === 'number') return str > 0 ? str : null;
  const m = String(str).replace(/,/g, '').match(/[\d.]+/);
  const n = m ? parseFloat(m[0]) : null;
  return n > 0 ? n : null;
}

// ── specs — same lowercase_underscore key convention already used by
// extractAmazonProductData() in routes/tracker/index.js (e.g. "Brand Name" -> brand_name),
// so the existing `specs?.brand_name` eBay-aspect fallback in routes/ebay.js keeps working.
function normalizeSpecKey(k) {
  return k.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function getSpecs(data) {
  const specs = {};
  const info = data.product_information || {};
  for (const [k, v] of Object.entries(info)) {
    if (v == null || typeof v === 'object') continue; // skip nested (Best Sellers Rank array, Customer Reviews obj)
    const key = normalizeSpecKey(k);
    if (key && key.length > 1) specs[key] = String(v);
  }
  if (data.full_description) {
    const desc = String(data.full_description).replace(/<[^>]+>/g, '').trim();
    if (desc.length > 10) specs.description = desc;
  }
  return specs;
}

// customization_options is keyed by dimension ("Size", "Color"), each holding sibling ASINs
// relative to the CURRENT page's selection — not a flat cross-product list like Keepa gave us.
// For single-dimension variant products (only Color, or only Size) this is a complete match.
// For products varying on two dimensions at once, this only surfaces "other colors of this
// size" and "other sizes of this color", not every combination — a real gap vs. the old Keepa
// path, called out here rather than silently shipped as equivalent.
function getVariants(data, baseDomain) {
  const opts = data.customization_options;
  if (!opts || typeof opts !== 'object') return [];
  const byAsin = new Map();
  for (const [dimension, entries] of Object.entries(opts)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (!e.asin) continue;
      if (!byAsin.has(e.asin)) byAsin.set(e.asin, { asin: e.asin, attributes: [], image: e.image || null });
      if (e.value) byAsin.get(e.asin).attributes.push({ dimension, value: e.value });
    }
  }
  return Array.from(byAsin.values()).map(v => ({
    asin: v.asin,
    label: v.attributes.map(a => a.value).filter(Boolean).join(' / ') || v.asin,
    attributes: v.attributes,
    price: null,
    image: v.image,
    url: `${baseDomain}/dp/${v.asin}`,
  }));
}

// ── Core ScraperAPI call ────────────────────────────────────────────────────
// autoparse=true on an Amazon product page — verified live: 5 credits/request (not the
// 1-credit "free plan" rate an old comment here used to claim), no render=true needed since
// Amazon PDPs are server-rendered HTML.
async function callScraperApi(amazonUrl) {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) throw new Error("SCRAPER_API_KEY not set");

  const { data } = await axios.get(SCRAPER_API_BASE, {
    params: { api_key: key, url: amazonUrl, autoparse: 'true' },
    timeout: 60000,
  });

  if (!data || (!data.name && !data.pricing)) {
    throw new Error(`ScraperAPI: no product data returned for ${amazonUrl}`);
  }
  return data;
}

// ── Main export ───────────────────────────────────────────────────────────────
// priceOnly — return just price/stock, used by the scheduler for routine checks on
// already-tracked products. Full metadata (title, images, specs, variants) is only needed
// once, at add-time, via POST /api/tracker.
async function fetchProduct(url, { priceOnly = false } = {}) {
  const asin = extractAsin(url);
  if (!asin) throw new Error("Could not extract ASIN from URL");

  const domainMatch = url.match(/(https?:\/\/[^/]+)/);
  const baseDomain  = domainMatch ? domainMatch[1] : "https://www.amazon.com";

  const data = await callScraperApi(`${baseDomain}/dp/${asin}`);
  const price = parsePrice(data.pricing) || parsePrice(data.prime_price);

  if (!price) {
    const err = new Error(data.availability_status || "Out of stock / unavailable on Amazon");
    err.code = 'OUT_OF_STOCK';
    throw err;
  }

  console.log(`scraperapi: fetched ${asin} — price=${price}, status=${data.availability_status || '?'}`);

  if (priceOnly) {
    return {
      title: null, price, currency: "$",
      image: null, images: [], upc: null,
      variants: [], isPrime: null, variant: null, attributes: [], specs: {},
    };
  }

  const title      = data.name || "Unknown product";
  const listPriceRaw = parsePrice(data.list_price);
  const listPrice  = listPriceRaw && listPriceRaw > price ? listPriceRaw : null;
  const images     = Array.isArray(data.highResImages) && data.highResImages.length ? data.highResImages : (data.images || []);
  const image      = images[0] || null;
  // No UPC/EAN field in ScraperAPI's autoparse output (Keepa's upcList/eanList had it) — left
  // null, same fallback behavior as when Keepa itself didn't have it for a given product.
  const upc        = null;
  const isPrime    = !!data.prime_price || /amazon(\.com)?$/i.test((data.sold_by || '').trim()) || /prime/i.test(data.shipping_time || '');
  const specs      = getSpecs(data);
  const bullets    = Array.isArray(data.feature_bullets) ? data.feature_bullets : [];
  const ratingNum  = typeof data.average_rating === 'number' ? data.average_rating : parseFloat(data.average_rating);
  const rating     = Number.isFinite(ratingNum) && ratingNum > 0 ? ratingNum : null;
  const reviewCount = Number(data.total_reviews ?? data.total_ratings) || 0;

  const variants = getVariants(data, baseDomain);
  let variant = null, attributes = [];
  const self = variants.find(v => v.asin === asin);
  if (self) { variant = self.label; attributes = self.attributes; }
  if (!variant) {
    // Fallback: single-dimension Color/Size straight off product_information, mirroring the
    // old Keepa path's fallback for products with no structured variant data at all.
    const parts = [data.product_information?.Color, data.product_information?.['Size Name']].filter(Boolean);
    if (parts.length) variant = parts.join(' / ');
  }

  const isNewRelease = false;

  return { title, price, currency: "$", listPrice, image, images, upc, variants, isPrime, variant, attributes, specs, bullets, rating, reviewCount, isNewRelease };
}

module.exports = { cleanUrl, extractAsin, fetchProduct };
