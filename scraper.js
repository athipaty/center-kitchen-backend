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

// Raw (non-autoparse) HTML fetch — 1 credit vs autoparse's 5. Used for the multi-dimension
// variant-matrix fallback, and as the primary path for priceOnly checks (see parsePriceFromRawHtml).
async function callScraperApiRaw(amazonUrl) {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) throw new Error("SCRAPER_API_KEY not set");

  const { data } = await axios.get(SCRAPER_API_BASE, {
    params: { api_key: key, url: amazonUrl },
    timeout: 60000,
  });

  if (typeof data !== 'string' || data.length < 1000) {
    throw new Error(`ScraperAPI: no HTML returned for ${amazonUrl}`);
  }
  return data;
}

// ── Free direct-to-Amazon fetch (0 ScraperAPI credits) ──────────────────────────────────────
// Tried first for priceOnly checks; callScraperApiRaw/callScraperApi below are the fallback
// for whatever this misses (bot-check pages, layout changes, this server's IP getting flagged).
// Two things proved necessary in testing, beyond a browser User-Agent:
//  - Referer + a short jittered delay before the request: a burst of bare stateless requests
//    with no pacing is what actually trips Amazon's bot-check (tested 4/5 blocked without this,
//    0/5 blocked with it) — headers alone weren't the fix.
//  - "i18n-prefs=USD; lc-main=en_US" cookies: without them Amazon geo-locates the request and
//    silently serves a different currency (e.g. S$ for a Singapore-originating IP) instead of
//    erroring, which would quietly corrupt tracked prices rather than failing loudly.
// Scoped to amazon.com only — the Referer/cookie pair here is US-specific, so other Amazon
// domains (co.uk, ca, ...) skip straight to the ScraperAPI tiers below.
const DIRECT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Referer": "https://www.amazon.com/",
  "Cookie": "i18n-prefs=USD; lc-main=en_US",
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(minMs, maxMs) { return minMs + Math.random() * (maxMs - minMs); }

async function fetchDirectPriceOnly(asin, baseDomain) {
  if (!/amazon\.com$/i.test(baseDomain.replace(/^https?:\/\//, ''))) return { price: null };
  await sleep(jitter(1500, 4000));
  const resp = await axios.get(`${baseDomain}/dp/${asin}`, {
    headers: DIRECT_HEADERS,
    timeout: 15000,
    validateStatus: () => true,
  });
  if (typeof resp.data !== 'string' || resp.data.length < 1000) return { price: null };
  if (/captcha|robot check|api-services-support@amazon/i.test(resp.data)) return { price: null };
  return parsePriceFromRawHtml(resp.data);
}

// Cheap price/stock extraction straight off raw Amazon HTML (no autoparse). Scoped to the
// #corePrice_feature_div buybox container, NOT the first "a-offscreen">$X.XX on the whole page —
// that page-wide scan was the root cause of wildly wrong prices on variant/twister products
// (Color/Size dropdowns): Amazon server-renders that container EMPTY for those listings (price
// gets hydrated client-side by JS based on the selected variant), so the old page-wide regex
// silently grabbed an unrelated price from a "customers also bought" carousel or comparison
// table instead — confirmed live 2026-08-11 (25/158 tracked items had wrong stored prices, all
// but a couple were variant products with an empty corePrice_feature_div). If the container is
// missing/empty, callers should fall back to the autoparse path rather than trusting a page-wide
// match as real — the regex is fragile to Amazon layout changes in a way autoparse isn't.
function parsePriceFromRawHtml(html) {
  const containerIdx = html.indexOf('id="corePrice_feature_div"');
  const searchWindow = containerIdx !== -1 ? html.slice(containerIdx, containerIdx + 3000) : null;
  const priceMatch = searchWindow ? searchWindow.match(/class="a-offscreen">\s*\$\s*([\d,]+\.\d{2})/) : null;
  const price = priceMatch ? parsePrice(priceMatch[1]) : null;

  let availabilityText = null;
  const availIdx = html.indexOf('id="availability"');
  if (availIdx !== -1) {
    availabilityText = html.slice(availIdx, availIdx + 500)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || null;
  }

  return { price, availabilityText };
}

// Extracts a balanced { ... } JSON object that follows "key" : in raw HTML/JS source.
// Needed because these blobs sit inside a larger <script> JS object literal, not standalone
// JSON, so a naive non-greedy regex breaks on any nested braces.
function extractJsonAfterKey(html, key) {
  const keyIdx = html.indexOf(`"${key}"`);
  if (keyIdx === -1) return null;
  const start = html.indexOf('{', keyIdx);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function humanizeDimensionKey(key) {
  return key.replace(/_name$/i, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Amazon's raw PDP HTML embeds its own full cross-product variant matrix
// ("dimensionValuesDisplayData": { asin: [dim1Value, dim2Value, ...] }, keyed in the same
// order as "variationValues": { size_name: [...], color_name: [...] }). Unlike
// customization_options (ScraperAPI autoparse), this isn't relative to whichever ASIN's page
// got scraped, and it reliably carries text values for dropdown-style dimensions (e.g. Size)
// that autoparse sometimes returns as bare asin-only entries with no value at all.
// knownDimensions (from customization_options) lets us borrow Amazon's own dimension label
// (e.g. "Color") instead of a generated one, by matching on overlapping values.
function extractFullVariantMatrix(html, baseDomain, knownDimensions = {}) {
  const displayData = extractJsonAfterKey(html, 'dimensionValuesDisplayData');
  const variationValues = extractJsonAfterKey(html, 'variationValues');
  if (!displayData || !variationValues) return null;

  const dimKeys = Object.keys(variationValues);
  if (!dimKeys.length) return null;
  const dimNames = dimKeys.map(k => {
    const values = variationValues[k] || [];
    for (const [label, valueSet] of Object.entries(knownDimensions)) {
      if (values.some(v => valueSet.has(v))) return label;
    }
    return humanizeDimensionKey(k);
  });

  const variants = [];
  for (const [asin, values] of Object.entries(displayData)) {
    if (!Array.isArray(values) || !asin) continue;
    const attributes = values
      .map((value, i) => ({ dimension: dimNames[i] || dimKeys[i], value }))
      .filter(a => a.value && a.value !== 'Please Select');
    if (!attributes.length) continue;
    variants.push({
      asin, attributes,
      label: attributes.map(a => a.value).join(' / '),
      price: null, image: null,
      url: `${baseDomain}/dp/${asin}`,
    });
  }
  return variants.length ? variants : null;
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

  if (priceOnly) {
    // Three tiers, cheapest first, each one only a fallback for the one before it — so a miss
    // at any tier just costs the next tier's price, never a false out-of-stock (which feeds the
    // 7-day dead-listing auto-end logic):
    //   1. free direct-to-Amazon (0 credits)
    //   2. ScraperAPI raw fetch (1 credit)
    //   3. ScraperAPI autoparse (5 credits)
    try {
      const direct = await fetchDirectPriceOnly(asin, baseDomain);
      if (direct.price) {
        console.log(`direct: fetched ${asin} — price=${direct.price}`);
        return {
          title: null, price: direct.price, currency: "$",
          image: null, images: [], upc: null,
          variants: [], isPrime: null, variant: null, attributes: [], specs: {},
        };
      }
    } catch (e) {
      console.log(`direct: failed for ${asin}: ${e.message}`);
    }

    const html = await callScraperApiRaw(`${baseDomain}/dp/${asin}`);
    let { price, availabilityText } = parsePriceFromRawHtml(html);

    if (price) {
      console.log(`scraperapi(raw): fetched ${asin} — price=${price}`);
      return {
        title: null, price, currency: "$",
        image: null, images: [], upc: null,
        variants: [], isPrime: null, variant: null, attributes: [], specs: {},
      };
    }

    console.log(`scraperapi(raw): no price for ${asin}, falling back to autoparse`);
    const data = await callScraperApi(`${baseDomain}/dp/${asin}`);
    price = parsePrice(data.pricing) || parsePrice(data.prime_price);
    if (!price) {
      const err = new Error(data.availability_status || availabilityText || "Out of stock / unavailable on Amazon");
      err.code = 'OUT_OF_STOCK';
      throw err;
    }
    console.log(`scraperapi: fetched ${asin} — price=${price}, status=${data.availability_status || '?'}`);
    return {
      title: null, price, currency: "$",
      image: null, images: [], upc: null,
      variants: [], isPrime: null, variant: null, attributes: [], specs: {},
    };
  }

  const data = await callScraperApi(`${baseDomain}/dp/${asin}`);
  const price = parsePrice(data.pricing) || parsePrice(data.prime_price);

  if (!price) {
    const err = new Error(data.availability_status || "Out of stock / unavailable on Amazon");
    err.code = 'OUT_OF_STOCK';
    throw err;
  }

  console.log(`scraperapi: fetched ${asin} — price=${price}, status=${data.availability_status || '?'}`);

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

  let variants = getVariants(data, baseDomain);

  // customization_options only surfaces siblings relative to the CURRENT page's selection,
  // and for some listings drops a dimension's text values entirely (see extractFullVariantMatrix).
  // Scoped to genuinely multi-dimension products (2+ keys) — single-dimension listings already
  // get complete, correctly-labeled data from customization_options alone, so skip the extra
  // ScraperAPI call there.
  const dimKeys = Object.keys(data.customization_options || {});
  if (dimKeys.length >= 2) {
    try {
      const knownDimensions = {};
      for (const dim of dimKeys) {
        const vals = new Set((data.customization_options[dim] || []).map(e => e.value).filter(Boolean));
        if (vals.size) knownDimensions[dim] = vals;
      }
      const html = await callScraperApiRaw(`${baseDomain}/dp/${asin}`);
      const fullMatrix = extractFullVariantMatrix(html, baseDomain, knownDimensions);
      if (fullMatrix && fullMatrix.length >= variants.length) {
        // Carry over swatch images already known from customization_options where asins match
        const imageByAsin = new Map(variants.filter(v => v.image).map(v => [v.asin, v.image]));
        console.log(`scraper: full-matrix fallback expanded ${asin} from ${variants.length} to ${fullMatrix.length} variants`);
        variants = fullMatrix.map(v => ({ ...v, image: imageByAsin.get(v.asin) || null }));
      }
    } catch (e) {
      console.log(`scraper: full-matrix fallback failed for ${asin}: ${e.message}`);
    }
  }

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
