const axios = require("axios");
const cheerio = require("cheerio");

function cleanUrl(url) {
  const full = url.startsWith('http') ? url : `https://${url}`;
  const match = full.match(
    /(https?:\/\/[a-z.]*amazon\.[a-z.]+\/(?:[^/]+\/)?dp\/[A-Z0-9]{10})/i
  );
  return match ? match[1] : full;
}

function extractAsin(url) {
  const match = url.match(/\/dp\/([A-Z0-9]{10})/i);
  return match ? match[1] : null;
}

function parsePrice(text) {
  if (!text) return null;
  const clean = String(text).replace(/,/g, "").trim();
  const match = clean.match(/[\d]+\.?\d*/);
  return match ? parseFloat(match[0]) : null;
}

function parseVariants(data) {
  // Primary: customization_options.{color,size,...} — each entry has asin + value + image
  const opts = data.customization_options;
  if (opts && typeof opts === 'object') {
    const seen = new Set();
    const result = [];
    for (const [dimension, options] of Object.entries(opts)) {
      if (!Array.isArray(options)) continue;
      for (const opt of options) {
        if (!opt.asin || !opt.value || seen.has(opt.asin)) continue;
        seen.add(opt.asin);
        result.push({ asin: opt.asin, label: opt.value, price: null, image: opt.image || null });
      }
    }
    if (result.length > 0) return result;
  }

  // Fallback: data.variants array (some products use this format)
  const rawVariants = data.variants;
  if (!Array.isArray(rawVariants) || !rawVariants.length) return [];
  return rawVariants.map(v => {
    const asin = v.asin || v.ASIN;
    if (!asin) return null;
    let label = '';
    const attrs = v.attributes || v.variationAttributes || {};
    if (Array.isArray(attrs)) {
      label = attrs.map(a => a.value || a.name || '').filter(Boolean).join(' / ');
    } else if (typeof attrs === 'object' && Object.keys(attrs).length) {
      label = Object.values(attrs).join(' / ');
    }
    if (!label) label = v.title || v.dimension_value || v.value || asin;
    const price = parsePrice(v.price || v.pricing || v.original_price);
    return { asin, label: label.trim(), price: price || null, image: null };
  }).filter(Boolean);
}

// Lightweight direct price check — no ScraperAPI credits used.
// Returns { price, currency } or null if blocked/failed.
async function tryDirectPrice(url) {
  try {
    const { data: html } = await axios.get(url, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (html.includes('validateCaptcha') || html.includes('robot')) return null;
    const $ = require('cheerio').load(html);
    let price = null;
    for (const sel of ['.priceToPay .a-offscreen', '.apexPriceToPay .a-offscreen', '#priceblock_ourprice', '#price_inside_buybox', '.a-price .a-offscreen']) {
      price = parsePrice($(sel).first().attr('content') || $(sel).first().text());
      if (price) break;
    }
    if (!price) return null;
    let currency = '$';
    for (const sym of ['฿', '£', '€', '$']) {
      if (html.slice(0, 8000).includes(sym)) { currency = sym; break; }
    }
    return { price, currency };
  } catch { return null; }
}

async function fetchProduct(url, { priceOnly = false } = {}) {
  const scraperKey = process.env.SCRAPER_API_KEY;
  const asin = extractAsin(url);

  // Price-only mode: try direct curl first to save ScraperAPI credits
  if (priceOnly && scraperKey && asin) {
    const direct = await tryDirectPrice(url);
    if (direct) {
      console.log(`scraper: direct price OK for ${asin} ($${direct.price}) — no ScraperAPI credit used`);
      return { title: null, price: direct.price, currency: direct.currency, image: null, images: [], upc: null, variants: [], isPrime: null, variant: null, specs: {} };
    }
    console.log(`scraper: direct fetch blocked for ${asin} — falling back to ScraperAPI`);
  }

  // Use ScraperAPI structured endpoint when key + ASIN available
  if (scraperKey && asin) {
    try {
      const { data } = await axios.get(
        `https://api.scraperapi.com/structured/amazon/product/v1`,
        {
          params: { api_key: scraperKey, asin },
          timeout: 60000,
        }
      );

      const title = data.name || "Unknown product";

      // Detect out-of-stock before attempting price parse
      const availability = (data.availability || '').toLowerCase();
      if (availability && (
        availability.includes('out of stock') ||
        availability.includes('currently unavailable') ||
        availability.includes('unavailable')
      )) {
        const err = new Error(`Out of stock: ${data.availability}`);
        err.code = 'OUT_OF_STOCK';
        throw err;
      }

      const price = parsePrice(data.pricing || data.original_price);
      if (!price) throw new Error("Price not found in ScraperAPI response.");

      const currency = data.currency === "USD" ? "$"
        : data.currency === "GBP" ? "£"
        : data.currency === "EUR" ? "€"
        : data.currency === "THB" ? "฿"
        : "$";

      const image = data.images?.[0] || data.main_image || null;
      const images = Array.isArray(data.images) && data.images.length ? data.images : (image ? [image] : []);

      const upc = data.upc
        || data.product_information?.upc
        || data.product_information?.ean
        || data.product_information?.global_trade_identification_number
        || null;

      const variants = parseVariants(data);

      const shipsFromAmazon = typeof data.ships_from === 'string' && data.ships_from.toLowerCase().includes('amazon');
      const soldByAmazon   = typeof data.sold_by    === 'string' && data.sold_by.toLowerCase().includes('amazon');
      const isPrime = !!(data.prime || data.is_prime || shipsFromAmazon || soldByAmazon);

      // Build variant label from all selected customization options (color, size, style, etc.)
      const selectedParts = [];
      if (data.customization_options && typeof data.customization_options === 'object') {
        for (const options of Object.values(data.customization_options)) {
          if (!Array.isArray(options)) continue;
          const selected = options.find(o => o.is_selected && o.value);
          if (selected) selectedParts.push(selected.value);
        }
      }
      const variant = selectedParts.join(' / ') || data.product_information?.color || null;

      const specs = data.product_information || {};

      // Capture bullet point features (Amazon "About this item")
      const bullets = Array.isArray(data.feature_bullets) ? data.feature_bullets
        : Array.isArray(data.features) ? data.features
        : Array.isArray(data.about_this_item) ? data.about_this_item
        : [];

      return { title, price, currency, image, images, upc, variants, isPrime, variant, specs, bullets };
    } catch (err) {
      throw new Error(`ScraperAPI error: ${err.response?.data?.message || err.message}`);
    }
  }

  // Fallback: direct axios+cheerio for local dev (no API key)
  let html;
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
    });
    html = res.data;
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }

  const $ = cheerio.load(html);

  if ($("form[action='/errors/validateCaptcha']").length) {
    throw new Error("Amazon is showing a CAPTCHA. Add a SCRAPER_API_KEY env var to bypass this.");
  }

  let title = "Unknown product";
  for (const sel of ["#productTitle", "#title", "h1.a-size-large"]) {
    const text = $(sel).first().text().trim();
    if (text) { title = text; break; }
  }

  let price = null;
  for (const sel of [".priceToPay .a-offscreen", ".apexPriceToPay .a-offscreen", "#priceblock_ourprice", "#priceblock_dealprice", "#price_inside_buybox", ".a-price .a-offscreen"]) {
    const el = $(sel).first();
    price = parsePrice(el.attr("content") || el.text());
    if (price) break;
  }

  const bodyText = $.text().toLowerCase();
  if (!price && (bodyText.includes('currently unavailable') || bodyText.includes('out of stock'))) {
    const err = new Error('Out of stock');
    err.code = 'OUT_OF_STOCK';
    throw err;
  }
  if (!price) throw new Error("Price not found. The product may be out of stock or the URL is unsupported.");

  let currency = "$";
  for (const sym of ["฿", "£", "€", "¥", "$"]) {
    if (html.slice(0, 10000).includes(sym)) { currency = sym; break; }
  }

  return { title, price, currency, variants: [] };
}

module.exports = { cleanUrl, extractAsin, fetchProduct };
