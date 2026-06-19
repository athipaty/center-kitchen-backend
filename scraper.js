const axios = require("axios");

// ── Keepa API constants ───────────────────────────────────────────────────────
const KEEPA_CDN = "https://images-na.ssl-images-amazon.com/images/I/";
const KEEPA_API = "https://api.keepa.com/product";

// ── Cache (in-memory hot layer + MongoDB persistence) ────────────────────────
// Keepa refreshes product data every few hours; 6h TTL keeps us in sync
// while avoiding redundant token spend on every scheduler run.
const _cache   = new Map(); // asin → { data, expiresAt }
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6h

let CacheModel;
try { CacheModel = require('./models/tracker/ScraperCache'); } catch {}

async function warmCacheFromDB() {
  if (!CacheModel) return;
  try {
    const entries = await CacheModel.find({ expiresAt: { $gt: new Date() } }).lean();
    for (const e of entries) _cache.set(e._id, { data: e.data, expiresAt: new Date(e.expiresAt).getTime() });
    if (entries.length) console.log(`keepa: warmed cache — ${entries.length} ASINs loaded, 0 tokens spent`);
  } catch (e) { console.warn('keepa: cache warm failed:', e.message); }
}
warmCacheFromDB();

async function persistCache(asin, data, expiresAt) {
  if (!CacheModel) return;
  try {
    await CacheModel.findByIdAndUpdate(
      asin,
      { data, expiresAt: new Date(expiresAt) },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch {}
}

// ── URL helpers (unchanged from ScraperAPI version) ──────────────────────────
function cleanUrl(url) {
  const full = url.startsWith('http') ? url : `https://${url}`;
  const match = full.match(/(https?:\/\/[a-z.]*amazon\.[a-z.]+\/(?:[^/]+\/)?dp\/[A-Z0-9]{10})/i);
  return match ? match[1] : full;
}

function extractAsin(url) {
  const match = url.match(/\/dp\/([A-Z0-9]{10})/i);
  return match ? match[1] : null;
}

// ── Keepa price helpers ───────────────────────────────────────────────────────
// Keepa stores prices in cents; -1 means "no data / not sold at this price type"
function kPrice(cents) {
  return (cents != null && cents !== -1 && cents > 0) ? cents / 100 : null;
}

// Buy Box = what a buyer would actually pay. Amazon direct as fallback, then New FBA.
function getCurrentPrice(stats) {
  if (!stats?.current) return null;
  return kPrice(stats.current[3])   // Buy Box
      || kPrice(stats.current[0])   // Amazon
      || kPrice(stats.current[7])   // New FBA
      || null;
}

// List price (strikethrough) is at index 11
function getListPrice(stats) {
  return kPrice(stats?.current?.[11]) || null;
}

// Prime = Amazon is the seller (availabilityAmazon=1, or Amazon has a live price)
function isSoldByAmazon(product) {
  if (product.availabilityAmazon === 1) return true;
  return kPrice(product.stats?.current?.[0]) != null;
}

function getImages(product) {
  if (!product.imagesCSV) return [];
  return product.imagesCSV.split(',').filter(Boolean).map(s => `${KEEPA_CDN}${s.trim()}`);
}

function getSpecs(product) {
  const s = {};
  if (product.asin)         s.asin         = product.asin;
  if (product.brand)        s.brand        = product.brand;
  if (product.color)        s.color        = product.color;
  if (product.size)         s.size         = product.size;
  if (product.manufacturer && product.manufacturer !== product.brand)
    s.manufacturer = product.manufacturer;
  if (product.packageWeight > 0)
    s.item_weight = `${(product.packageWeight / 100).toFixed(2)} kg`;
  return s;
}

// Keepa variation attributes: [{dimension:"Color",value:"Red"},{dimension:"Size",value:"L"}]
function labelFromAttrs(attrs) {
  if (!Array.isArray(attrs) || !attrs.length) return null;
  return attrs.map(a => a.value).filter(Boolean).join(' / ') || null;
}

// ── Core Keepa API call ───────────────────────────────────────────────────────
async function callKeepa(asin, extra = {}) {
  const key = process.env.KEEPA_API_KEY;
  if (!key) throw new Error("KEEPA_API_KEY not set");

  const { data } = await axios.get(KEEPA_API, {
    params: { key, asin, domain: 1, stats: 1, buybox: 1, history: 0, ...extra },
    timeout: 30000,
  });

  if (data.error) throw new Error(`Keepa API error: ${data.error.message || JSON.stringify(data.error)}`);
  if (!data.products?.length) throw new Error(`Keepa: no product found for ASIN ${asin}`);
  if (data.tokensLeft != null) console.log(`keepa: ${asin} — tokensLeft=${data.tokensLeft}`);

  return data.products[0];
}

// ── Variant discovery ─────────────────────────────────────────────────────────
async function fetchVariants(product, baseDomain) {
  // PARENT type already has the full variation list
  if (product.type === 'PARENT' && Array.isArray(product.variations) && product.variations.length) {
    return product.variations.map(v => ({
      asin:  v.asin,
      label: labelFromAttrs(v.attributes) || v.asin,
      price: null,  // prices fetched individually when each variant is tracked
      image: null,
      url:   `${baseDomain}/dp/${v.asin}`,
    }));
  }

  // VARIATION type — need to fetch parent to discover siblings
  if (product.parentAsin && product.type !== 'STANDARD') {
    try {
      const parent = await callKeepa(product.parentAsin);
      if (Array.isArray(parent.variations) && parent.variations.length) {
        return parent.variations.map(v => ({
          asin:  v.asin,
          label: labelFromAttrs(v.attributes) || v.asin,
          price: null,
          image: null,
          url:   `${baseDomain}/dp/${v.asin}`,
        }));
      }
    } catch (e) {
      console.warn(`keepa: parent fetch failed for ${product.parentAsin}:`, e.message);
    }
  }

  return [];
}

// ── Main export ───────────────────────────────────────────────────────────────
async function fetchProduct(url, { priceOnly = false } = {}) {
  const asin = extractAsin(url);
  if (!asin) throw new Error("Could not extract ASIN from URL");

  const domainMatch = url.match(/(https?:\/\/[^/]+)/);
  const baseDomain  = domainMatch ? domainMatch[1] : "https://www.amazon.com";

  // Cache only used for full fetches; price-only always fetches fresh data
  const cached = !priceOnly && _cache.get(asin);
  let product;

  if (cached && cached.expiresAt > Date.now()) {
    console.log(`keepa: cache hit for ${asin} — 0 tokens`);
    product = cached.data;
  } else {
    product = await callKeepa(asin, { history: priceOnly ? 0 : 1 });
    if (!priceOnly) {
      const expiresAt = Date.now() + CACHE_TTL;
      _cache.set(asin, { data: product, expiresAt });
      persistCache(asin, product, expiresAt);
    }
    console.log(`keepa: fetched ${asin} — type=${product.type ?? '?'}, price=${getCurrentPrice(product.stats) ?? 'none'}`);
  }

  const price = getCurrentPrice(product.stats);
  if (!price) {
    const err = new Error("Out of stock / unavailable on Amazon");
    err.code = 'OUT_OF_STOCK';
    throw err;
  }

  // Price-only: return trimmed object matching the existing contract used by trackerScheduler
  if (priceOnly) {
    return {
      title: null, price, currency: "$",
      image: null, images: [], upc: null,
      variants: [], isPrime: null, variant: null, specs: {},
    };
  }

  const title      = product.title || "Unknown product";
  const lp         = getListPrice(product.stats);
  const listPrice  = lp && lp > price ? lp : null;
  const images     = getImages(product);
  const image      = images[0] || null;
  const upc        = product.upcList?.[0] || product.eanList?.[0] || null;
  const isPrime    = isSoldByAmazon(product);
  const specs      = getSpecs(product);
  const bullets    = Array.isArray(product.features) ? product.features : [];
  const rating     = product.rating > 0 ? product.rating / 10 : null;
  const reviewCount = product.countReviews || 0;
  const isNewRelease = false;

  // Variant label for this specific ASIN from its variation attributes
  let variant = null;
  if (product.variationAttributes && typeof product.variationAttributes === 'object') {
    const parts = Object.values(product.variationAttributes).filter(Boolean);
    if (parts.length) variant = parts.join(' / ');
  }

  const variants = await fetchVariants(product, baseDomain);

  return { title, price, currency: "$", listPrice, image, images, upc, variants, isPrime, variant, specs, bullets, rating, reviewCount, isNewRelease };
}

module.exports = { cleanUrl, extractAsin, fetchProduct };
