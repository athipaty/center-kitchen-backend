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

// Keepa stats.current index mapping (verified against live API responses):
// [0]=Amazon price, [1]=Marketplace New, [2]=Marketplace Used, [3]=Sales Rank (NOT price!),
// [4]=List/reference price, [7]=New FBA (Prime-eligible 3rd party), [18]=Warehouse Deals
function getCurrentPrice(stats) {
  if (!stats?.current) return null;
  return kPrice(stats.current[0])   // Amazon direct (best — definitely Prime)
      || kPrice(stats.current[7])   // New FBA (also Prime)
      || kPrice(stats.current[1])   // Marketplace New
      || null;
}

// List price (Amazon's reference/strikethrough price) is at index 4
function getListPrice(stats) {
  return kPrice(stats?.current?.[4]) || null;
}

// Prime = sold by Amazon directly, FBA, or current buy box winner is Prime-eligible
function isSoldByAmazon(product) {
  if (product.availabilityAmazon === 1) return true;
  if (product.buyBoxIsPrime) return true;
  return kPrice(product.stats?.current?.[0]) != null
      || kPrice(product.stats?.current?.[7]) != null;
}

function getImages(product) {
  if (product.imagesCSV) {
    return product.imagesCSV.split(',').filter(Boolean).map(s => `${KEEPA_CDN}${s.trim()}`);
  }
  // Fallback: single image slug on the product itself (common for variation children)
  if (product.image) return [`${KEEPA_CDN}${product.image}`];
  // Fallback: find self in variations list
  if (Array.isArray(product.variations)) {
    const self = product.variations.find(v => v.asin === product.asin);
    if (self?.image) return [`${KEEPA_CDN}${self.image}`];
  }
  return [];
}

function getSpecs(product) {
  const s = {};
  const set = (k, v) => { if (v != null && v !== '' && v !== 0) s[k] = v; };

  set('asin', product.asin);
  set('brand', product.brand);
  set('color', product.color);
  set('size', product.size);
  set('style', product.style);
  set('pattern', product.pattern);
  set('material', product.material);
  set('model_number', product.model);
  set('manufacturer_part_number', product.partNumber);
  if (product.manufacturer && product.manufacturer !== product.brand)
    set('manufacturer', product.manufacturer);
  if (product.binding) set('product_type', product.binding);
  if (product.numberOfItems > 0) set('number_of_items', String(product.numberOfItems));
  if (product.batteryType) set('battery_type', product.batteryType);

  // Weights
  if (product.itemWeight > 0) set('item_weight', `${(product.itemWeight / 100).toFixed(2)} kg`);
  else if (product.packageWeight > 0) set('item_weight', `${(product.packageWeight / 100).toFixed(2)} kg`);

  // Item dimensions (cm from Keepa, converted to inches)
  const cmToIn = v => v > 0 ? `${(v / 100 * 0.3937).toFixed(2)}"` : null;
  const il = cmToIn(product.itemLength), iw = cmToIn(product.itemWidth), ih = cmToIn(product.itemHeight);
  if (il && iw && ih) set('item_dimensions', `${il}L x ${iw}W x ${ih}H`);

  // Package dimensions
  const pl = cmToIn(product.packageLength), pw = cmToIn(product.packageWidth), ph = cmToIn(product.packageHeight);
  if (pl && pw && ph) set('package_dimensions', `${pl}L x ${pw}W x ${ph}H`);

  // Ratings
  if (product.rating > 0) set('customer_rating', `${(product.rating / 10).toFixed(1)} / 5`);
  if (product.countReviews > 0) set('review_count', String(product.countReviews));

  // Package quantity (distinct from numberOfItems — e.g. "2 packs of 10")
  if (product.packageQuantity > 1) set('package_quantity', String(product.packageQuantity));

  // Item type — Keepa's product classification string (e.g. "WASH_CLOTHS" → "Wash Cloths")
  if (product.type) {
    const formatted = product.type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    set('item_type', formatted);
  }

  // Best sellers rank + category breadcrumb
  if (product.salesRankReference > 0 && Array.isArray(product.categoryTree) && product.categoryTree.length) {
    const topCat = product.categoryTree[0]?.name || 'Amazon';
    set('best_sellers_rank', `#${product.salesRankReference.toLocaleString()} in ${topCat}`);
  }

  // Most specific product subcategory
  if (Array.isArray(product.categoryTree) && product.categoryTree.length > 1) {
    const deepest = product.categoryTree[product.categoryTree.length - 1];
    if (deepest?.name) set('product_subcategory', deepest.name);
  }

  // Monthly sold estimate (Keepa's approximation)
  if (product.monthlySold > 0) set('estimated_monthly_sold', `${product.monthlySold}+`);

  // Description text (not always present, but useful when Keepa provides it)
  if (product.description && String(product.description).length > 10)
    set('description', String(product.description).replace(/<[^>]+>/g, '').trim());

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
// Keepa variation entries: { asin, attributes: [{dimension, value}], image (slug) }
// Note: product.type is a product category string (e.g. "SUNGLASSES"), not PARENT/VARIATION.
// Use product.variations presence and product.parentAsin to detect the relationship.
function mapVariations(variations, baseDomain) {
  return variations.map(v => ({
    asin:       v.asin,
    label:      labelFromAttrs(v.attributes) || v.asin,
    attributes: Array.isArray(v.attributes) ? v.attributes : [],
    price:      null,
    image:      v.image ? `${KEEPA_CDN}${v.image}` : null,
    url:        `${baseDomain}/dp/${v.asin}`,
  }));
}

async function fetchVariants(product, baseDomain, cachedParent = null) {
  // Variations list already populated on this product (common for both parent and child)
  if (Array.isArray(product.variations) && product.variations.length) {
    return mapVariations(product.variations, baseDomain);
  }

  // No variations on this product — try fetching parent if we have its ASIN
  if (product.parentAsin) {
    try {
      const parent = cachedParent || await callKeepa(product.parentAsin);
      if (Array.isArray(parent.variations) && parent.variations.length) {
        return mapVariations(parent.variations, baseDomain);
      }
    } catch (e) {
      console.warn(`keepa: parent fetch failed for ${product.parentAsin}:`, e.message);
    }
  }

  return [];
}

// ── Main export ───────────────────────────────────────────────────────────────
// priceOnly    — return just price, 1 token, no second call (scheduler: established products)
// skipVariants — full metadata but skip parent-ASIN lookup, 1 token (scheduler: missing title/image)
// Variant discovery is only needed in the user-facing preview flow, not routine checks.
// history is always 0 — we never use Keepa's CSV arrays; history lives in MongoDB.
async function fetchProduct(url, { priceOnly = false, skipVariants = false, forceRefresh = false } = {}) {
  const asin = extractAsin(url);
  if (!asin) throw new Error("Could not extract ASIN from URL");

  const domainMatch = url.match(/(https?:\/\/[^/]+)/);
  const baseDomain  = domainMatch ? domainMatch[1] : "https://www.amazon.com";

  // Cache only used for full fetches; price-only always fetches fresh data
  const cached = !priceOnly && !forceRefresh && _cache.get(asin);
  let product;

  if (cached && cached.expiresAt > Date.now()) {
    console.log(`keepa: cache hit for ${asin} — 0 tokens`);
    product = cached.data;
  } else {
    product = await callKeepa(asin, { history: 0 }); // history: 0 always — saves ~2 tokens vs history: 1
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
  const upc        = product.upcList?.[0] || product.eanList?.[0] || null;
  const isPrime    = isSoldByAmazon(product);
  const specs      = getSpecs(product);
  const bullets    = Array.isArray(product.features) ? product.features : [];
  const rating     = product.rating > 0 ? product.rating / 10 : null;
  const reviewCount = product.countReviews || 0;
  const isNewRelease = false;

  // Variant label: find this ASIN in the variations list (most reliable source)
  let variant = null;
  if (Array.isArray(product.variations)) {
    const self = product.variations.find(v => v.asin === product.asin);
    if (self) variant = labelFromAttrs(self.attributes);
  }
  // Fallback: product's own color/size fields
  if (!variant) {
    const parts = [product.color, product.size].filter(Boolean);
    if (parts.length) variant = parts.join(' / ');
  }

  // Variation children from Keepa only carry 1 image (the color swatch).
  // The full product gallery lives on the parent ASIN — fetch it so every
  // variant gets the complete photo set for the eBay listing.
  let images = getImages(product);
  let parentProduct = null;
  if (images.length <= 1 && product.parentAsin && !skipVariants) {
    try {
      parentProduct = await callKeepa(product.parentAsin);
      const parentImages = getImages(parentProduct);
      if (parentImages.length > images.length) {
        // Keep the variant's own image first (colour-specific swatch), then gallery
        images = images[0]
          ? [images[0], ...parentImages.filter(u => u !== images[0])].slice(0, 12)
          : parentImages.slice(0, 12);
        console.log(`keepa: supplemented ${asin} images from parent ${product.parentAsin} — ${images.length} total`);
      }
    } catch (e) {
      console.warn(`keepa: parent image fetch for ${product.parentAsin} failed:`, e.message);
    }
  }
  const image = images[0] || null;

  // skipVariants=true during scheduler checks avoids a second callKeepa for the parent ASIN.
  // Pass cachedParent so fetchVariants reuses it if we already fetched it above.
  const variants = skipVariants ? [] : await fetchVariants(product, baseDomain, parentProduct);

  return { title, price, currency: "$", listPrice, image, images, upc, variants, isPrime, variant, specs, bullets, rating, reviewCount, isNewRelease };
}

module.exports = { cleanUrl, extractAsin, fetchProduct };
