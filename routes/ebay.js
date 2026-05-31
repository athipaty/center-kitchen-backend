const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const EbayToken = require('../models/shared/EbayToken');

const Product = require('../models/tracker/Product');

let _io = null;
function setIo(socketIo) { _io = socketIo; }

// ── Sold-price cache (6h TTL) ──────────────────────────────────────
const soldCache = new Map(); // key → { data, expiresAt }
const SOLD_TTL = 6 * 60 * 60 * 1000;

// ── Image proxy (eBay can't fetch Amazon CDN directly) ─────────────
const imageProxyCache = new Map(); // key → { buffer, contentType, expiresAt }
const IMAGE_PROXY_TTL = 15 * 60 * 1000; // 15 min — enough for eBay to fetch it

async function proxyImageUrl(amazonUrl) {
  if (!amazonUrl) return null;
  try {
    const { data, headers } = await axios.get(amazonUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const key = require('crypto').randomBytes(16).toString('hex');
    imageProxyCache.set(key, {
      buffer: Buffer.from(data),
      contentType: headers['content-type'] || 'image/jpeg',
      expiresAt: Date.now() + IMAGE_PROXY_TTL,
    });
    const base = (process.env.BACKEND_URL || 'https://center-kitchen-backend.onrender.com').replace(/\/$/, '');
    return `${base}/api/ebay/img/${key}`;
  } catch (e) {
    console.log('proxyImageUrl failed:', e.message);
    return null;
  }
}

// Serve proxied images so eBay can fetch them
router.get('/img/:key', (req, res) => {
  const entry = imageProxyCache.get(req.params.key);
  if (!entry || Date.now() > entry.expiresAt) {
    imageProxyCache.delete(req.params.key);
    return res.status(404).send('expired');
  }
  res.setHeader('Content-Type', entry.contentType);
  res.send(entry.buffer);
});

// Upgrade Amazon CDN image URL to full resolution by removing size qualifiers.
// e.g. "717NzLPWXhL._AC_SL1500_.jpg" → "717NzLPWXhL.jpg" (original full-res)
// Falls back to the original URL if the upgraded version fails to download.
function upgradeAmazonImageUrl(url) {
  if (!url || !url.includes('m.media-amazon.com/images/I/')) return url;
  return url.replace(/\._[A-Z0-9_]+_(?=\.jpg)/i, '');
}

// ── Upload Amazon images to Cloudinary permanently ─────────────────
router.post('/upload-images', async (req, res) => {
  const { imageUrls, slug } = req.body;
  if (!imageUrls?.length || !slug) return res.status(400).json({ error: 'imageUrls and slug required' });

  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  const cloudinaryUrls = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    try {
      // Try full-resolution first, fall back to original URL if it fails
      const fullResUrl = upgradeAmazonImageUrl(url);
      let imgBuffer;
      try {
        ({ data: imgBuffer } = await axios.get(fullResUrl, {
          responseType: 'arraybuffer', timeout: 15000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        }));
        if (fullResUrl !== url) console.log(`upload-images: upgraded ${url.split('/').pop()} → full-res (${(imgBuffer.length / 1024).toFixed(0)} KB)`);
      } catch {
        // Full-res not available — fall back to original
        ({ data: imgBuffer } = await axios.get(url, {
          responseType: 'arraybuffer', timeout: 15000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        }));
      }

      const folder = `ebay-listings/${slug}`;
      const publicId = `${slug}-${String(i + 1).padStart(2, '0')}`;
      const timestamp = Math.floor(Date.now() / 1000);

      const toSign = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
      const signature = crypto.createHash('sha1').update(toSign).digest('hex');

      const b64 = Buffer.from(imgBuffer).toString('base64');
      const contentType = 'image/jpeg';
      const dataUri = `data:${contentType};base64,${b64}`;

      const uploadParams = new URLSearchParams({
        file: dataUri,
        api_key: apiKey,
        timestamp: String(timestamp),
        signature,
        folder,
        public_id: publicId,
      });

      const { data: uploaded } = await axios.post(
        `https://api.cloudinary.com/v1_1/${cloud}/image/upload`,
        uploadParams.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
      );
      cloudinaryUrls.push(uploaded.secure_url);
    } catch (e) {
      console.error(`upload-images: failed for ${url}:`, e.response?.data || e.message);
    }
  }

  if (!cloudinaryUrls.length) return res.status(500).json({ error: 'All image uploads failed' });
  res.json({ cloudinaryUrls });
});

function getCached(key) {
  const entry = soldCache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.data;
  soldCache.delete(key);
  return null;
}
function setCache(key, data) {
  soldCache.set(key, { data, expiresAt: Date.now() + SOLD_TTL });
}

// ── Token persistence (MongoDB — survives Render restarts) ─────────
let tokens = { access_token: null, refresh_token: null, expires_at: 0, refresh_token_expires_at: 0 };

// Load tokens from MongoDB on startup
(async () => {
  try {
    const doc = await EbayToken.findById('ebay');
    if (doc) tokens = { access_token: doc.access_token, refresh_token: doc.refresh_token, expires_at: doc.expires_at };
  } catch {}
})();

async function saveTokens() {
  try {
    await EbayToken.findByIdAndUpdate('ebay', tokens, { upsert: true, new: true });
  } catch {}
}

function basicAuth() {
  return Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');
}

function authError() {
  const err = new Error('not_authenticated');
  err.status = 401;
  return err;
}

async function getAccessToken() {
  // Lazy-load from DB if in-memory tokens are empty (e.g. first request after restart)
  if (!tokens.refresh_token) {
    try {
      const doc = await EbayToken.findById('ebay');
      if (doc) tokens = { access_token: doc.access_token, refresh_token: doc.refresh_token, expires_at: doc.expires_at, refresh_token_expires_at: doc.refresh_token_expires_at || 0 };
    } catch {}
  }
  if (tokens.access_token && Date.now() < tokens.expires_at - 60000) return tokens.access_token;
  if (!tokens.refresh_token) throw authError();
  try {
    const { data } = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
      { headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokens.access_token = data.access_token;
    tokens.expires_at = Date.now() + data.expires_in * 1000;
    await saveTokens();
    return tokens.access_token;
  } catch {
    tokens = { access_token: null, refresh_token: null, expires_at: 0 };
    await saveTokens();
    throw authError();
  }
}

// ── Helpers ────────────────────────────────────────────────────────
function parseItems(items) {
  return (items || []).map(item => ({
    id: item.itemId?.[0],
    title: item.title?.[0],
    price: parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0),
    currency: item.sellingStatus?.[0]?.currentPrice?.[0]?.['@currencyId'] || 'USD',
    image: item.galleryURL?.[0],
    url: item.viewItemURL?.[0],
    condition: item.condition?.[0]?.conditionDisplayName?.[0] || 'Unknown',
    shipping: parseFloat(item.shippingInfo?.[0]?.shippingServiceCost?.[0]?.__value__ || 0),
  }));
}

function ebayError(err) {
  const ebayMsg = err.response?.data?.errorMessage?.[0]?.error?.[0]?.message?.[0];
  return ebayMsg || err.response?.data || err.message;
}

// ── OAuth ──────────────────────────────────────────────────────────
router.get('/auth/login', (req, res) => {
  if (!process.env.EBAY_RUNAME) return res.status(500).json({ error: 'EBAY_RUNAME not set in .env' });
  const scope = [
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/sell.finances',
    'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
  ].join(' ');
  const url = `https://auth.ebay.com/oauth2/authorize?client_id=${encodeURIComponent(process.env.EBAY_APP_ID)}&redirect_uri=${encodeURIComponent(process.env.EBAY_RUNAME)}&response_type=code&scope=${encodeURIComponent(scope)}`;
  res.redirect(url);
});

router.get('/auth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) {
    return res.status(400).send(`eBay authorization failed: ${error_description || error}`);
  }
  if (!code) return res.status(400).send('No authorization code received from eBay.');
  try {
    const { data } = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.EBAY_RUNAME }),
      { headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const EIGHTEEN_MONTHS = 18 * 30 * 24 * 3600 * 1000;
    tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      refresh_token_expires_at: Date.now() + (data.refresh_token_expires_in ? data.refresh_token_expires_in * 1000 : EIGHTEEN_MONTHS),
    };
    await saveTokens();
    res.redirect(`${process.env.CLIENT_URL}/ebay?connected=1`);
  } catch (err) {
    res.status(500).send('eBay auth failed: ' + (err.response?.data?.error_description || err.message));
  }
});

router.get('/auth/status', async (_req, res) => {
  if (!tokens.refresh_token) {
    try {
      const doc = await EbayToken.findById('ebay');
      if (doc) tokens = { access_token: doc.access_token, refresh_token: doc.refresh_token, expires_at: doc.expires_at, refresh_token_expires_at: doc.refresh_token_expires_at || 0 };
    } catch {}
  }
  // Backfill expiry for existing tokens that pre-date this tracking (assume 18 months from now)
  if (tokens.refresh_token && !tokens.refresh_token_expires_at) {
    tokens.refresh_token_expires_at = Date.now() + 18 * 30 * 24 * 3600 * 1000;
    await saveTokens().catch(() => {});
  }
  const daysLeft = tokens.refresh_token_expires_at
    ? Math.floor((tokens.refresh_token_expires_at - Date.now()) / 86400000)
    : null;
  res.json({ connected: !!tokens.refresh_token, refreshTokenDaysLeft: daysLeft });
});

// ── Public search ──────────────────────────────────────────────────
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  if (!process.env.EBAY_APP_ID) return res.status(500).json({ error: 'EBAY_APP_ID is not set on the server.' });

  try {
    const { data } = await axios.get('https://svcs.ebay.com/services/search/FindingService/v1', {
      params: {
        'OPERATION-NAME': 'findItemsByKeywords',
        'SERVICE-VERSION': '1.0.0',
        'SECURITY-APPNAME': process.env.EBAY_APP_ID,
        'RESPONSE-DATA-FORMAT': 'JSON',
        keywords: q,
        'paginationInput.entriesPerPage': 12,
        'itemFilter(0).name': 'ListingType',
        'itemFilter(0).value(0)': 'FixedPrice',
        'itemFilter(0).value(1)': 'AuctionWithBIN',
        sortOrder: 'PricePlusShippingLowest',
      },
    });
    res.json(parseItems(data.findItemsByKeywordsResponse?.[0]?.searchResult?.[0]?.item));
  } catch (err) {
    res.status(500).json({ error: ebayError(err) });
  }
});

router.get('/upc', async (req, res) => {
  const { upc } = req.query;
  if (!upc) return res.status(400).json({ error: 'upc is required' });
  if (!process.env.EBAY_APP_ID) return res.status(500).json({ error: 'EBAY_APP_ID is not set on the server.' });

  try {
    const { data } = await axios.get('https://svcs.ebay.com/services/search/FindingService/v1', {
      params: {
        'OPERATION-NAME': 'findItemsByKeywords',
        'SERVICE-VERSION': '1.0.0',
        'SECURITY-APPNAME': process.env.EBAY_APP_ID,
        'RESPONSE-DATA-FORMAT': 'JSON',
        keywords: upc,
        'paginationInput.entriesPerPage': 12,
        sortOrder: 'PricePlusShippingLowest',
      },
    });
    res.json(parseItems(data.findItemsByKeywordsResponse?.[0]?.searchResult?.[0]?.item));
  } catch (err) {
    res.status(500).json({ error: ebayError(err) });
  }
});

// ── My Listings ────────────────────────────────────────────────────
router.get('/my-listings', async (req, res) => {
  try {
    const token = await getAccessToken();

    // Note: /sell/inventory/v1/offer does NOT support a status filter param
    let offersData;
    try {
      ({ data: offersData } = await axios.get('https://api.ebay.com/sell/inventory/v1/offer', {
        headers: { Authorization: `Bearer ${token}` },
        params: { limit: 100 },
      }));
    } catch (offerErr) {
      console.error('my-listings: GET /offer failed:', JSON.stringify(offerErr.response?.data ?? offerErr.message));
      return res.json([]);
    }

    const offers = offersData.offers || [];
    if (!offers.length) return res.json([]);

    // Use Shopping API (public) to get real titles + images by listing ID
    const listingIds = offers.map(o => o.listing?.listingId).filter(Boolean);
    const itemMap = {};
    for (let i = 0; i < listingIds.length; i += 20) {
      try {
        const { data: shopData } = await axios.get('https://open.api.ebay.com/shopping', {
          params: {
            callname: 'GetMultipleItems',
            responseencoding: 'JSON',
            appid: process.env.EBAY_APP_ID,
            version: '967',
            ItemID: listingIds.slice(i, i + 20).join(','),
            IncludeSelector: 'Details',
          },
        });
        (shopData.Item || []).forEach(item => {
          itemMap[item.ItemID] = { title: item.Title, image: item.PictureURL?.[0] };
        });
      } catch { /* skip on error, fall back to SKU */ }
    }

    res.json(offers.map(offer => {
      const detail = itemMap[offer.listing?.listingId] || {};
      return {
        offerId: offer.offerId,
        listingId: offer.listing?.listingId,
        sku: offer.sku,
        title: detail.title || offer.sku,
        image: detail.image || null,
        price: parseFloat(offer.pricingSummary?.price?.value || 0),
        currency: offer.pricingSummary?.price?.currency || 'USD',
        quantity: offer.availableQuantity ?? 0,
        url: offer.listing?.listingId ? `https://www.ebay.com/itm/${offer.listing.listingId}` : null,
      };
    }));
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated') {
      return res.status(401).json({ error: 'not_authenticated' });
    }
    const ebayErrs = err.response?.data?.errors;
    const detail = ebayErrs?.length
      ? ebayErrs.map(e => String(e.longMessage || e.message || '')).join(' | ')
      : String(err.message || 'Unknown error');
    console.error('my-listings error:', JSON.stringify(err.response?.data ?? err.message));
    res.status(500).json({ error: detail });
  }
});

// ── Account info (policies + locations) ───────────────────────────
router.get('/account-info', async (req, res) => {
  try {
    const token = await getAccessToken();
    const h = { Authorization: `Bearer ${token}` };
    const mid = 'EBAY_US';
    const [ful, ret, pay, loc] = await Promise.allSettled([
      axios.get(`https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=${mid}`, { headers: h }),
      axios.get(`https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=${mid}`, { headers: h }),
      axios.get(`https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=${mid}`, { headers: h }),
      axios.get('https://api.ebay.com/sell/inventory/v1/location', { headers: h }),
    ]);
    res.json({
      fulfillmentPolicies: ful.status === 'fulfilled' ? (ful.value.data.fulfillmentPolicies || []) : [],
      returnPolicies:      ret.status === 'fulfilled' ? (ret.value.data.returnPolicies      || []) : [],
      paymentPolicies:     pay.status === 'fulfilled' ? (pay.value.data.paymentPolicies     || []) : [],
      locations:           loc.status === 'fulfilled' ? (loc.value.data.locations           || []) : [],
    });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: ebayError(err) });
  }
});

// Fetch valid values + metadata for all aspects of an eBay category
async function getValidAspectValues(catId) {
  if (!catId) return {};
  try {
    const { data: appToken } = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }),
      { headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
    );
    const h = { Authorization: `Bearer ${appToken.access_token}` };
    const { data: specs } = await axios.get(
      `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${catId}`,
      { headers: h, timeout: 8000 }
    );
    const result = {};
    for (const aspect of (specs.aspects || [])) {
      result[aspect.localizedAspectName] = {
        required: aspect.aspectConstraint?.aspectRequired === true,
        values: (aspect.aspectValues || []).map(v => v.localizedValue),
      };
    }
    return result;
  } catch (e) {
    console.log('getValidAspectValues failed:', e.message);
    return {};
  }
}

// Word-boundary match: avoids "SK" matching inside "skimmer", etc.
function matchAspectValue(vals, title) {
  return vals.find(v => {
    if (!v) return false;
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${esc}\\b`, 'i').test(title);
  }) || null;
}

// Use Claude to pick the best Type value when title matching fails
async function pickBestAspectValue(fieldName, validValues, title) {
  if (!validValues.length) return null;
  if (validValues.length === 1) return validValues[0];
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{ role: 'user', content: `Product: "${title}"\nBest eBay "${fieldName}" from list: ${validValues.join(', ')}\nReply with ONLY the exact value from the list.` }],
    });
    const chosen = (msg.content[0]?.text || '').trim().replace(/^["']|["']$/g, '');
    return validValues.find(v => v.toLowerCase() === chosen.toLowerCase()) || validValues[0];
  } catch {
    return validValues[0];
  }
}

// Inject required item specifics before the first listing attempt
// Skips Brand (handled separately) and uses word-boundary matching + Claude fallback
async function injectTitleAspects(catId, aspects, title) {
  const catAspects = await getValidAspectValues(catId);
  if (!Object.keys(catAspects).length) return;
  for (const [name, info] of Object.entries(catAspects)) {
    if (aspects[name]) continue;
    if (name === 'Brand') continue; // Brand is set from specs, skip to avoid false title matches
    const matched = matchAspectValue(info.values, title);
    if (matched) {
      aspects[name] = [matched];
      console.log(`injectTitleAspects: matched ${name}="${matched}"`);
    } else if (info.required && info.values.length) {
      // Required field with no title match — use Claude to pick the best valid value
      const best = await pickBestAspectValue(name, info.values, title);
      if (best) {
        aspects[name] = [best];
        console.log(`injectTitleAspects: Claude picked ${name}="${best}"`);
      }
    }
  }
}

// Single-batch AI enrichment — fills all unfilled category aspects using product context
async function enrichAspectsWithAI(catId, aspects, title, specs, bullets = []) {
  const catAspects = await getValidAspectValues(catId);
  if (!Object.keys(catAspects).length) return;

  const missing = Object.entries(catAspects)
    .filter(([name]) => !aspects[name] && name !== 'Brand')
    .map(([name, info]) => ({
      name,
      ...(info.values.length ? { validValues: info.values.slice(0, 25) } : {}),
    }));

  if (!missing.length) return;

  const specText = specs
    ? Object.entries(specs)
        .filter(([k, v]) => v && !['asin', 'best_sellers_rank', 'customer_reviews', 'brand_name', 'manufacturer'].includes(k))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n')
    : '';
  const bulletText = bullets.length ? bullets.map(b => `- ${b}`).join('\n') : '';

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `Fill in eBay item specifics for this product.

Title: ${title}
${specText ? `\nSpecs:\n${specText}` : ''}
${bulletText ? `\nBullets:\n${bulletText}` : ''}

For each field below, provide a value based on the product info above.
- If "validValues" is listed, pick EXACTLY one value from that list (exact match, case-sensitive).
- If no validValues, provide a short accurate value (max 65 chars).
- Skip fields you cannot confidently answer — do not guess.

Return ONLY a JSON object: {"Field Name": "value", ...}
Do not include fields you are skipping.

Fields:
${JSON.stringify(missing)}`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = (msg.content[0]?.text || '').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const filled = JSON.parse(jsonMatch[0]);
    let count = 0;
    for (const [name, value] of Object.entries(filled)) {
      if (!value || aspects[name]) continue;
      const info = catAspects[name];
      if (info?.values?.length) {
        const match = info.values.find(v => v.toLowerCase() === String(value).toLowerCase());
        if (match) { aspects[name] = [match]; count++; }
      } else {
        aspects[name] = [String(value).slice(0, 65)]; count++;
      }
    }
    if (count) console.log(`enrichAspectsWithAI: filled ${count} aspects`);
  } catch (e) {
    console.log('enrichAspectsWithAI failed:', e.message);
  }
}

// ── Create listing ─────────────────────────────────────────────────
function buildAspects(specs) {
  const MAP = {
    brand_name: 'Brand', color: 'Color', material: 'Material',
    size: 'Size', style: 'Style', model_number: 'MPN',
    item_weight: 'Item Weight', wattage: 'Wattage', voltage: 'Voltage',
    power_source: 'Power Source', number_of_speeds: 'Number of Speeds',
    country_of_origin: 'Country/Region of Manufacture',
    indoor_outdoor_usage: 'Indoor/Outdoor Usage',
    special_features: 'Features', mounting_type: 'Mounting Type',
    connector_type: 'Connector Type', motor_type: 'Motor Type',
  };
  const aspects = {};
  for (const [k, label] of Object.entries(MAP)) {
    if (specs[k]) aspects[label] = [String(specs[k]).slice(0, 65)];
  }
  return aspects;
}

function sanitizeSku(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 50) || 'ITEM';
}

function sanitizeTitle(raw) {
  return String(raw || '')
    .replace(/[^\x20-\x7E]/g, ' ')      // non-ASCII → space (catches ™ ® © etc.)
    .replace(/[<>&"'|*]/g, '')           // HTML and special chars eBay chokes on
    .replace(/\b(ebay|walmart|target|amazon)\b/gi, '')  // competitor names
    .replace(/\b(guarantee|guaranteed|warranty|certified|authorized|authentic|genuine|official|oem)\b/gi, '')
    .replace(/\b(free shipping|free ship|free delivery|best price|lowest price|sale|discount)\b/gi, '')
    .replace(/100%/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 80);
}

// Auto-detect eBay category from live listings, falling back to Taxonomy API
async function lookupCategory(title, upc) {
  const findingBase = {
    'SERVICE-VERSION': '1.0.0',
    'SECURITY-APPNAME': process.env.EBAY_APP_ID,
    'RESPONSE-DATA-FORMAT': 'JSON',
    'paginationInput.entriesPerPage': 5,
    sortOrder: 'BestMatch',
  };
  const extractCat = data =>
    data?.findItemsByKeywordsResponse?.[0]?.searchResult?.[0]?.item?.[0]?.primaryCategory?.[0]?.categoryId?.[0]
    || data?.findItemsByProductResponse?.[0]?.searchResult?.[0]?.item?.[0]?.primaryCategory?.[0]?.categoryId?.[0]
    || null;

  if (process.env.EBAY_APP_ID) {
    // 1. UPC lookup (most accurate)
    if (upc) {
      try {
        const { data } = await axios.get('https://svcs.ebay.com/services/search/FindingService/v1', {
          params: { ...findingBase, 'OPERATION-NAME': 'findItemsByProduct', 'productId.@type': 'UPC', 'productId': upc },
        });
        const cat = extractCat(data);
        if (cat) return cat;
      } catch {}
    }

    // 2. Full title search
    try {
      const { data } = await axios.get('https://svcs.ebay.com/services/search/FindingService/v1', {
        params: { ...findingBase, 'OPERATION-NAME': 'findItemsByKeywords', keywords: title.slice(0, 100) },
      });
      const cat = extractCat(data);
      if (cat) return cat;
    } catch {}

    // 3. Shorter keywords (first 4 words)
    const short = title.split(/\s+/).slice(0, 4).join(' ');
    if (short.length < title.length) {
      try {
        const { data } = await axios.get('https://svcs.ebay.com/services/search/FindingService/v1', {
          params: { ...findingBase, 'OPERATION-NAME': 'findItemsByKeywords', keywords: short },
        });
        const cat = extractCat(data);
        if (cat) return cat;
      } catch {}
    }
  }

  // 4. Commerce Taxonomy API — uses Application token (client_credentials), not user token,
  //    so it works regardless of which scopes the user granted
  try {
    const { data: appToken } = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }),
      { headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const th = { Authorization: `Bearer ${appToken.access_token}` };
    const { data: tree } = await axios.get(
      'https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id',
      { headers: th, params: { marketplace_id: 'EBAY_US' } }
    );
    const { data: sugg } = await axios.get(
      `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${tree.categoryTreeId}/get_category_suggestions`,
      { headers: th, params: { q: title.slice(0, 80) } }
    );
    const cat = sugg.categorySuggestions?.[0]?.category?.categoryId;
    if (cat) {
      console.log(`lookupCategory: taxonomy category ${cat} for "${title.slice(0, 40)}"`);
      return String(cat);
    }
    console.log('lookupCategory: taxonomy API returned no suggestions for', title.slice(0, 40));
  } catch (e) {
    console.log('lookupCategory: taxonomy API failed:', e.response?.data?.error_description || e.response?.data || e.message);
  }

  return null;
}

// Words/patterns that trigger eBay's content policy filter
const EBAY_BLOCKED = /amazon|walmart|target|bestbuy|best buy|ebay|http|www\.|\.com|\.net|\.org|free ship|lowest price|best price|#1|visit our|check out our|see our store|money.back|satisfaction guaranteed|not sold in stores/i;

function safeSpecValue(v) {
  if (v == null) return null;
  const str = Array.isArray(v) ? v.join(', ') : (typeof v === 'object' ? Object.values(v).filter(Boolean).join(', ') : String(v));
  if (EBAY_BLOCKED.test(str)) return null;
  // Strip special chars that eBay's filter chokes on
  return str.replace(/[^\x20-\x7E]/g, '').replace(/[<>&"]/g, '').slice(0, 200).trim() || null;
}

function buildDescription() {
  // Keep description completely generic — any product-specific content risks
  // triggering eBay's content policy filter (competitor names, URLs, brand terms)
  return '<p>Please see photos and title for complete item details.</p>';
}

// Auto find-or-create all required policies + location so the user never has to configure them manually
async function resolveListingPolicies(token, { shipping, returns, zipCode }) {
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Language': 'en-US' };
  const mid = 'EBAY_US';
  const cats = [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }];

  // Opt into Business Policy program — safe to call even if already enrolled
  try {
    await axios.post(
      'https://api.ebay.com/sell/account/v1/program/opt_in',
      { programType: 'SELLING_POLICY_MANAGEMENT' },
      { headers: h }
    );
  } catch { /* already enrolled or not applicable — continue */ }

  // Helper: find policy by name or return null
  async function findPolicy(endpoint, listKey, name) {
    try {
      const { data } = await axios.get(`https://api.ebay.com/sell/account/v1/${endpoint}?marketplace_id=${mid}`, { headers: h });
      return (data[listKey] || []).find(p => p.name === name) || null;
    } catch { return null; }
  }

  // ── Fulfillment policy ──────────────────────────────────────────
  const fulName = shipping.free
    ? `Free_${shipping.carrier}_${shipping.handlingDays}d`
    : `Flat_${Number(shipping.cost).toFixed(2)}_${shipping.carrier}_${shipping.handlingDays}d`;

  let fulfillmentPolicyId;
  const existingFul = await findPolicy('fulfillment_policy', 'fulfillmentPolicies', fulName);
  if (existingFul) {
    fulfillmentPolicyId = existingFul.fulfillmentPolicyId;
  } else {
    try {
      const { data } = await axios.post('https://api.ebay.com/sell/account/v1/fulfillment_policy', {
        name: fulName, marketplaceId: mid, categoryTypes: cats,
        handlingTime: { unit: 'DAY', value: Number(shipping.handlingDays) || 1 },
        shippingOptions: [{
          optionType: 'DOMESTIC', costType: 'FLAT_RATE',
          shippingServices: [{
            shippingServiceCode: shipping.carrier || 'USPSFirstClass',
            shippingCost: { currency: 'USD', value: shipping.free ? '0.00' : String(Number(shipping.cost || 0).toFixed(2)) },
            sortOrder: 1,
          }],
        }],
      }, { headers: h });
      fulfillmentPolicyId = data.fulfillmentPolicyId;
    } catch {
      // Fallback: use any existing policy
      const { data } = await axios.get(`https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=${mid}`, { headers: h });
      fulfillmentPolicyId = data.fulfillmentPolicies?.[0]?.fulfillmentPolicyId;
      if (!fulfillmentPolicyId) throw new Error('No fulfillment policy available. Please set one up in your eBay Seller Hub.');
    }
  }

  // ── Return policy ───────────────────────────────────────────────
  const retName = returns.accepted ? `Returns_${returns.days}d_${returns.buyerPays ? 'BuyerPays' : 'SellerPays'}` : 'NoReturns';

  let returnPolicyId;
  const existingRet = await findPolicy('return_policy', 'returnPolicies', retName);
  if (existingRet) {
    returnPolicyId = existingRet.returnPolicyId;
  } else {
    try {
      const payload = { name: retName, marketplaceId: mid, categoryTypes: cats, returnsAccepted: !!returns.accepted };
      if (returns.accepted) {
        payload.returnPeriod = { unit: 'DAY', value: Number(returns.days) || 30 };
        payload.refundMethod = 'MONEY_BACK';
        payload.returnShippingCostPayer = returns.buyerPays ? 'BUYER' : 'SELLER';
      }
      const { data } = await axios.post('https://api.ebay.com/sell/account/v1/return_policy', payload, { headers: h });
      returnPolicyId = data.returnPolicyId;
    } catch {
      const { data } = await axios.get(`https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=${mid}`, { headers: h });
      returnPolicyId = data.returnPolicies?.[0]?.returnPolicyId;
      if (!returnPolicyId) throw new Error('No return policy available. Please set one up in your eBay Seller Hub.');
    }
  }

  // ── Payment policy ──────────────────────────────────────────────
  // Optional for eBay Managed Payments sellers; use first existing or create a basic one
  let paymentPolicyId = null;
  try {
    const { data } = await axios.get(`https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=${mid}`, { headers: h });
    paymentPolicyId = data.paymentPolicies?.[0]?.paymentPolicyId || null;
    if (!paymentPolicyId) {
      const { data: created } = await axios.post('https://api.ebay.com/sell/account/v1/payment_policy', {
        name: 'eBay Managed Payments', marketplaceId: mid, categoryTypes: cats, immediatePay: true,
      }, { headers: h });
      paymentPolicyId = created.paymentPolicyId;
    }
  } catch { /* managed payments — paymentPolicyId stays null, offer will still publish */ }

  // ── Merchant location ───────────────────────────────────────────
  let merchantLocationKey;
  try {
    // Use any existing location first
    const { data: locList } = await axios.get('https://api.ebay.com/sell/inventory/v1/location', { headers: h });
    const existing = locList.locations?.[0];
    if (existing) {
      merchantLocationKey = existing.merchantLocationKey;
    } else {
      // No locations found — create a default one
      const locKey = 'default-location';
      await axios.post(`https://api.ebay.com/sell/inventory/v1/location/${locKey}`, {
        location: { address: { postalCode: zipCode || '10001', country: 'US' } },
        locationTypes: ['WAREHOUSE'],
        name: 'Default Location',
      }, { headers: h });
      merchantLocationKey = locKey;
    }
  } catch (locErr) {
    const msg = locErr.response?.data?.errors?.[0]?.longMessage
      || locErr.response?.data?.errors?.[0]?.message
      || locErr.message;
    throw new Error(`Merchant location error: ${msg}`);
  }

  return { fulfillmentPolicyId, returnPolicyId, paymentPolicyId, merchantLocationKey };
}

router.post('/create-listing', async (req, res) => {
  let step = 'init';
  let safeTitle = '';
  let resolvedCategory = null;
  try {
    const token = await getAccessToken();
    const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Language': 'en-US' };

    const {
      sku, title, price, currency = 'USD', quantity = 1,
      condition = 'NEW', categoryId,
      imageUrl, imageUrls: imageUrlsRaw, upc, specs = {},
      shipping = { free: true, carrier: 'USPSFirstClass', handlingDays: 1 },
      returns = { accepted: true, days: 30, buyerPays: true },
      zipCode = '10001',
    } = req.body;
    // Merge all available image URLs, deduplicated, capped at 12 (eBay max 24 but 12 is plenty)
    const allImageUrls = [...new Set([
      ...(Array.isArray(imageUrlsRaw) ? imageUrlsRaw : []),
      ...(imageUrl ? [imageUrl] : []),
    ])].slice(0, 12);

    if (!sku || !title || !price) {
      return res.status(400).json({ error: 'Missing required fields: sku, title, price' });
    }

    safeTitle = sanitizeTitle(title);
    const safeSKU = sanitizeSku(sku);
    console.log(`create-listing: sku="${safeSKU}" title="${safeTitle.slice(0, 50)}"`);

    // Proactive check: if a published listing already exists for this SKU, return it immediately
    step = 'checking existing listing';
    try {
      const { data: existingOffers } = await axios.get(
        'https://api.ebay.com/sell/inventory/v1/offer',
        { headers: h, params: { sku: safeSKU } }
      );
      const publishedOffer = (existingOffers.offers || []).find(o => o.sku === safeSKU && o.listing?.listingId);
      if (publishedOffer) {
        console.log(`create-listing: SKU "${safeSKU}" already has live listing ${publishedOffer.listing.listingId}`);
        return res.json({ listingId: publishedOffer.listing.listingId, url: `https://www.ebay.com/itm/${publishedOffer.listing.listingId}` });
      }
    } catch {}

    step = 'resolving policies';
    const { fulfillmentPolicyId, returnPolicyId, paymentPolicyId, merchantLocationKey } =
      await resolveListingPolicies(token, { shipping, returns, zipCode });

    step = 'creating inventory item';
    const proxyUrls = (await Promise.all(allImageUrls.map(u => proxyImageUrl(u)))).filter(Boolean);
    console.log(`create-listing: proxied ${proxyUrls.length}/${allImageUrls.length} images`);
    const inventoryProduct = {
      title: safeTitle,
      description: buildDescription(),
      aspects: buildAspects(specs),
      ...(proxyUrls.length ? { imageUrls: proxyUrls } : {}),
      ...(upc ? { upc: [upc] } : {}),
    };
    await axios.put(
      `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(safeSKU)}`,
      {
        condition,
        product: inventoryProduct,
        availability: { shipToLocationAvailability: { quantity: Number(quantity) } },
      },
      { headers: h }
    );

    // Resolve category — use provided value, auto-detect from eBay search, or leave unset
    step = 'detecting category';
    resolvedCategory = categoryId ? String(categoryId) : null;
    if (!resolvedCategory) {
      resolvedCategory = await lookupCategory(safeTitle, upc);
      if (resolvedCategory) console.log(`create-listing: auto-detected category ${resolvedCategory} for "${safeTitle}"`);
    }

    step = 'creating offer';
    const offerPayload = {
      sku: safeSKU, marketplaceId: 'EBAY_US', format: 'FIXED_PRICE', listingDuration: 'GTC',
      pricingSummary: { price: { value: Number(price).toFixed(2), currency } },
      availableQuantity: Number(quantity),
      merchantLocationKey,
      listingPolicies: {
        fulfillmentPolicyId,
        returnPolicyId,
        ...(paymentPolicyId ? { paymentPolicyId } : {}),
      },
    };
    if (resolvedCategory) offerPayload.categoryId = resolvedCategory;

    let offerData;
    step = 'creating offer';

    // Helper: handle an existing draft — delete it so we can POST fresh with the correct category.
    // Returns { listingId, url } if already published, { deleted: true } if draft was removed.
    async function handleExistingOffer() {
      for (const params of [{ sku: safeSKU }, { limit: 200 }]) {
        try {
          const { data } = await axios.get('https://api.ebay.com/sell/inventory/v1/offer', { headers: h, params });
          const found = (data.offers || []).find(o => o.sku === safeSKU) || (params.limit ? (data.offers || [])[0] : null);
          if (!found) continue;
          console.log(`create-listing: found existing offer ${found.offerId} sku="${found.sku}" status=${found.status}`);

          if (found.listing?.listingId) {
            return { listingId: found.listing.listingId, url: `https://www.ebay.com/itm/${found.listing.listingId}` };
          }

          // Grab the draft's category as fallback before deleting
          if (!resolvedCategory && found.categoryId) {
            resolvedCategory = String(found.categoryId);
            offerPayload.categoryId = resolvedCategory;
            console.log(`create-listing: reusing draft categoryId ${resolvedCategory}`);
          }

          await axios.delete(`https://api.ebay.com/sell/inventory/v1/offer/${found.offerId}`, { headers: h });
          console.log(`create-listing: deleted draft ${found.offerId}, will create fresh`);
          return { deleted: true };
        } catch (e) {
          console.log('create-listing: handleExistingOffer error:', e.response?.data?.errors?.[0]?.message || e.message);
        }
      }
      return null;
    }

    try {
      ({ data: offerData } = await axios.post('https://api.ebay.com/sell/inventory/v1/offer', offerPayload, { headers: h }));
    } catch (offerErr) {
      const errs = offerErr.response?.data?.errors || [];
      const isExistsErr = errs.some(e => /already exists/i.test(String(e.longMessage || e.message || '')));
      const isCatErr = errs.some(e => /categoryid|category/i.test(String(e.longMessage || e.message || '')));

      if (isExistsErr) {
        const existing = await handleExistingOffer();
        if (!existing) throw new Error('A draft offer already exists on eBay but could not be found or deleted. Please delete it manually in eBay Seller Hub → Listings → Drafts, then try again.');
        if (existing.url) return res.json({ listingId: existing.listingId, url: existing.url });
        // Draft deleted — create fresh
        ({ data: offerData } = await axios.post('https://api.ebay.com/sell/inventory/v1/offer', offerPayload, { headers: h }));
      } else if (isCatErr && offerPayload.categoryId) {
        console.log(`create-listing: categoryId "${offerPayload.categoryId}" rejected, retrying without`);
        delete offerPayload.categoryId;
        resolvedCategory = null;
        ({ data: offerData } = await axios.post('https://api.ebay.com/sell/inventory/v1/offer', offerPayload, { headers: h }));
      } else {
        throw offerErr;
      }
    }

    step = 'publishing offer';
    let published;
    try {
      ({ data: published } = await axios.post(
        `https://api.ebay.com/sell/inventory/v1/offer/${offerData.offerId}/publish`,
        {}, { headers: h }
      ));
    } catch (pubErr) {
      const pubErrs = pubErr.response?.data?.errors || [];
      const errText = pubErrs.map(e => String(e.longMessage || e.message || '')).join(' ');
      const noCatErr = /category/i.test(errText);
      const alreadyLiveErr = /revise listing|already active|already published/i.test(errText);
      const is25019 = pubErrs.some(e => e.errorId === 25019 || String(e.errorId) === '25019');
      const is25002Err = errs => errs.some(e => e.errorId === 25002 || String(e.errorId) === '25002');

      if (alreadyLiveErr) {
        // Try to return the existing live listing ID before anything else
        let foundListingId = null;
        try {
          const { data: offerDetail } = await axios.get(
            `https://api.ebay.com/sell/inventory/v1/offer/${offerData.offerId}`, { headers: h }
          );
          if (offerDetail.listing?.listingId) foundListingId = offerDetail.listing.listingId;
        } catch {}
        if (!foundListingId) {
          try {
            const { data: skuOffers } = await axios.get(
              'https://api.ebay.com/sell/inventory/v1/offer', { headers: h, params: { sku: safeSKU } }
            );
            const liveOffer = (skuOffers.offers || []).find(o => o.listing?.listingId);
            if (liveOffer) foundListingId = liveOffer.listing.listingId;
          } catch {}
        }
        if (foundListingId) {
          console.log(`create-listing: returning existing live listing ${foundListingId} after revise-error`);
          return res.json({ listingId: foundListingId, url: `https://www.ebay.com/itm/${foundListingId}` });
        }
        // No live listing found — if it's also a 25019, fall through to category retry below
        if (!is25019) throw pubErr;
      }
      if (is25019) {
        // 25019 is a content-policy error — changing category doesn't help.
        // Strip the variant suffix and all aspects, then retry with the same leaf category.
        // Helper: PUT inventory item with a given title (no aspects, plain description)
        const putStripped = async (t, imgs = proxyUrls) => axios.put(
          `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(safeSKU)}`,
          {
            condition,
            product: {
              title: t,
              description: 'See photos and title for complete item details.',
              aspects: {},
              ...(imgs.length ? { imageUrls: imgs } : {}),
            },
            availability: { shipToLocationAvailability: { quantity: Number(quantity) } },
          },
          { headers: h }
        );
        const tryPublish = async () => axios.post(
          `https://api.ebay.com/sell/inventory/v1/offer/${offerData.offerId}/publish`,
          {}, { headers: h }
        );

        // Attempt 1: strip variant suffix (e.g. " - Natural")
        step = 'publish retry stripped';
        const strippedTitle = safeTitle.replace(/\s+-\s+\S.*$/, '').trim();
        console.log(`create-listing: 25019 stripped retry title="${strippedTitle}"`);
        try {
          await putStripped(strippedTitle);
          if (!resolvedCategory) {
            resolvedCategory = await lookupCategory(strippedTitle, upc);
            if (resolvedCategory) {
              offerPayload.categoryId = resolvedCategory;
              const { sku: _s, marketplaceId: _m, format: _f, ...uf } = offerPayload;
              await axios.put(`https://api.ebay.com/sell/inventory/v1/offer/${offerData.offerId}`, uf, { headers: h });
            }
          }
          ({ data: published } = await tryPublish());
        } catch (e1) {
          console.log('create-listing: stripped retry failed:', e1.response?.data?.errors?.map(e => `[${e.errorId}] ${e.longMessage || e.message}`).join(' | ') || e1.message);
        }

        // Attempt 2: also remove brand (first word) and model numbers (e.g. CB-3)
        if (!published) {
          step = 'publish retry no-brand';
          const noBrandTitle = strippedTitle
            .split(' ')
            .slice(1)                                          // drop first word (brand)
            .filter(w => !/^[A-Z0-9]+-[A-Z0-9]+$/i.test(w))  // drop model numbers like CB-3
            .join(' ')
            .trim()
            .slice(0, 80);
          console.log(`create-listing: 25019 no-brand retry title="${noBrandTitle}"`);
          if (noBrandTitle) {
            try {
              await putStripped(noBrandTitle);
              ({ data: published } = await tryPublish());
            } catch (e2) {
              console.log('create-listing: no-brand retry failed:', e2.response?.data?.errors?.map(e => `[${e.errorId}] ${e.longMessage || e.message}`).join(' | ') || e2.message);
            }
          }
        }

        // Attempt 3: proxy URLs may be unreachable (Render sleeps) — try with original Amazon URLs,
        // then with no images at all, keeping the stripped title
        if (!published && allImageUrls.length) {
          step = 'publish retry direct-images';
          console.log('create-listing: 25019 direct-image retry (skip proxy)');
          try {
            await putStripped(strippedTitle, allImageUrls);
            ({ data: published } = await tryPublish());
          } catch (e3) {
            console.log('create-listing: direct-image retry failed:', e3.response?.data?.errors?.map(e => `[${e.errorId}] ${e.longMessage || e.message}`).join(' | ') || e3.message);
          }
        }

        if (!published) {
          step = 'publish retry no-images';
          console.log('create-listing: 25019 no-image retry');
          try {
            await putStripped(strippedTitle, []);
            ({ data: published } = await tryPublish());
          } catch (e4) {
            console.log('create-listing: no-image retry failed:', e4.response?.data?.errors?.map(e => `[${e.errorId}] ${e.longMessage || e.message}`).join(' | ') || e4.message);
          }
        }

        if (!published) throw pubErr;
      } else if (is25002Err(pubErrs)) {
        // Round 1: extract the missing required item specific and add "Other" as value
        const field = errText.match(/item specific\s+(\S+)\s+is missing/i)?.[1];
        step = `adding missing item specific ${field || ''}`;
        console.log(`create-listing: 25002 missing item specific "${field}", adding Other`);
        if (field) {
          const patchedAspects = { ...buildAspects(specs), [field]: ['Other'] };
          await axios.put(
            `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(safeSKU)}`,
            {
              condition,
              product: {
                title: safeTitle,
                description: buildDescription(),
                aspects: patchedAspects,
                ...(proxyUrls.length ? { imageUrls: proxyUrls } : {}),
                ...(upc ? { upc: [upc] } : {}),
              },
              availability: { shipToLocationAvailability: { quantity: Number(quantity) } },
            },
            { headers: h }
          );
          ({ data: published } = await axios.post(
            `https://api.ebay.com/sell/inventory/v1/offer/${offerData.offerId}/publish`,
            {}, { headers: h }
          ));
        } else {
          throw pubErr;
        }
      } else if (noCatErr) {
        step = 'fixing category before publish';
        const fallbackCat = await lookupCategory(safeTitle, upc);
        if (!fallbackCat) throw new Error('Could not detect an eBay category. Please enter a valid category ID manually.');
        const { sku: _s, marketplaceId: _m, format: _f, ...uf } = { ...offerPayload, categoryId: fallbackCat };
        await axios.put(`https://api.ebay.com/sell/inventory/v1/offer/${offerData.offerId}`, uf, { headers: h });
        ({ data: published } = await axios.post(
          `https://api.ebay.com/sell/inventory/v1/offer/${offerData.offerId}/publish`,
          {}, { headers: h }
        ));
      } else {
        throw pubErr;
      }
    }

    res.json({ listingId: published.listingId, url: `https://www.ebay.com/itm/${published.listingId}` });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    const ebayErrs = err.response?.data?.errors;
    const detail = ebayErrs?.length
      ? ebayErrs.map(e => `[${e.errorId}] ${e.longMessage || e.message || ''}`).join(' | ')
      : String(err.message || 'Unknown error');
    console.error(`create-listing [${step}] title="${safeTitle}" category="${resolvedCategory}" error:`, JSON.stringify(err.response?.data ?? err.message, null, 2));
    res.status(500).json({ error: `[${step}] ${detail} | title sent: "${safeTitle}"` });
  }
});

// ── Create group (multi-variation) listing ─────────────────────────
router.post('/create-group-listing', async (req, res) => {
  try {
    const token = await getAccessToken();
    const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Language': 'en-US' };

    const {
      groupKey,           // e.g. base ASIN — unique identifier for this group
      title,
      price,              // single price for the whole group
      currency = 'USD',
      condition = 'NEW',
      categoryId,
      variants,           // [{ sku, label, image, quantity }]
      specs = {},
      shipping = { free: true, carrier: 'USPSFirstClass', handlingDays: 1 },
      returns = { accepted: true, days: 30, buyerPays: true },
      zipCode = '10001',
    } = req.body;

    if (!groupKey || !title || !price || !variants?.length) {
      return res.status(400).json({ error: 'Missing required fields: groupKey, title, price, variants' });
    }

    const safeTitle = sanitizeTitle(title);
    const safeGroupKey = sanitizeSku(groupKey);
    const { fulfillmentPolicyId, returnPolicyId, paymentPolicyId, merchantLocationKey } =
      await resolveListingPolicies(token, { shipping, returns, zipCode });

    // Determine the "varies by" dimension name from variant labels
    // Use "Color" as default; if labels contain "/" we use "Style"
    const variesBy = variants.some(v => v.label?.includes('/')) ? 'Style' : 'Color';

    // 1. PUT each variant as its own inventory item
    const skus = [];
    for (const v of variants) {
      const sku = sanitizeSku(v.sku || `${groupKey}${v.label.replace(/[^a-zA-Z0-9]/g, '').slice(0, 15)}`);
      skus.push(sku);
      await axios.put(
        `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
        {
          condition,
          product: {
            title: safeTitle,
            description: buildDescription(),
            imageUrls: [v.image].filter(Boolean),
            aspects: {
              ...buildAspects(specs),
              [variesBy]: [v.label],
            },
          },
          availability: { shipToLocationAvailability: { quantity: Number(v.quantity) || 1 } },
        },
        { headers: h }
      );
    }

    // 2. PUT inventory item group
    const allImages = variants.map(v => v.image).filter(Boolean);
    await axios.put(
      `https://api.ebay.com/sell/inventory/v1/inventory_item_group/${encodeURIComponent(safeGroupKey)}`,
      {
        inventoryItemGroupKey: safeGroupKey,
        title: safeTitle,
        description: buildDescription(),
        aspects: {
          ...buildAspects(specs),
          [variesBy]: variants.map(v => v.label),
        },
        variantSKUs: skus,
        imageUrls: allImages.length ? allImages : undefined,
        variesBy: { aspectsImageVariesBy: [variesBy], specifications: [{ name: variesBy, values: variants.map(v => v.label) }] },
      },
      { headers: h }
    );

    // 3. Resolve category
    let resolvedGroupCategory = categoryId ? String(categoryId) : null;
    if (!resolvedGroupCategory) {
      resolvedGroupCategory = await lookupCategory(safeTitle, null);
      if (resolvedGroupCategory) console.log(`create-group-listing: auto-detected category ${resolvedGroupCategory}`);
    }

    // 4. Create offer for the group
    const offerPayload = {
      sku: safeGroupKey,
      marketplaceId: 'EBAY_US',
      format: 'FIXED_PRICE',
      listingDuration: 'GTC',
      pricingSummary: { price: { value: Number(price).toFixed(2), currency } },
      merchantLocationKey,
      listingPolicies: {
        fulfillmentPolicyId,
        returnPolicyId,
        ...(paymentPolicyId ? { paymentPolicyId } : {}),
      },
    };
    if (resolvedGroupCategory) offerPayload.categoryId = resolvedGroupCategory;

    const { data: offerData } = await axios.post('https://api.ebay.com/sell/inventory/v1/offer', offerPayload, { headers: h });

    // 5. Publish
    const { data: published } = await axios.post(
      `https://api.ebay.com/sell/inventory/v1/offer/${offerData.offerId}/publish`,
      {}, { headers: h }
    );

    res.json({ listingId: published.listingId, url: `https://www.ebay.com/itm/${published.listingId}` });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    const ebayErrs = err.response?.data?.errors;
    const detail = ebayErrs?.length
      ? ebayErrs.map(e => e.longMessage || e.message).join(' | ')
      : (err.message || 'Unknown error');
    console.error('create-group-listing error:', JSON.stringify(err.response?.data ?? err.message));
    res.status(500).json({ error: detail });
  }
});

// ── Debug: test aspect injection for a title ─────────────────────
router.get('/debug/aspects', async (req, res) => {
  const { title, catId: qCatId } = req.query;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const safeT = sanitizeTitle(title);
  const catId = qCatId || await lookupCategory(safeT, null);
  const catAspects = await getValidAspectValues(catId);
  const injected = {};
  for (const [name, info] of Object.entries(catAspects)) {
    if (name === 'Brand') continue;
    const matched = matchAspectValue(info.values, safeT);
    if (matched) injected[name] = matched;
    else if (info.required && info.values.length) injected[`${name}(claude-needed)`] = info.values.slice(0, 3).join(' / ');
  }
  res.json({ safeTitle: safeT, catId, aspectsApiWorked: Object.keys(catAspects).length > 0, injected });
});

// ── Diagnose eBay listing readiness ───────────────────────────────
router.get('/diagnose', async (req, res) => {
  const report = {};
  try {
    const token = await getAccessToken();
    report.auth = 'ok';
    const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Language': 'en-US' };
    const mid = 'EBAY_US';

    // Opt-in
    try {
      await axios.post('https://api.ebay.com/sell/account/v1/program/opt_in',
        { programType: 'SELLING_POLICY_MANAGEMENT' }, { headers: h });
      report.optIn = 'enrolled (or already was)';
    } catch (e) {
      report.optIn = `failed: ${e.response?.data?.errors?.[0]?.message || e.message}`;
    }

    // Fulfillment policies
    try {
      const { data } = await axios.get(`https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=${mid}`, { headers: h });
      report.fulfillmentPolicies = (data.fulfillmentPolicies || []).map(p => ({ id: p.fulfillmentPolicyId, name: p.name }));
    } catch (e) {
      report.fulfillmentPolicies = `failed: ${e.response?.data?.errors?.[0]?.message || e.message}`;
    }

    // Return policies
    try {
      const { data } = await axios.get(`https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=${mid}`, { headers: h });
      report.returnPolicies = (data.returnPolicies || []).map(p => ({ id: p.returnPolicyId, name: p.name }));
    } catch (e) {
      report.returnPolicies = `failed: ${e.response?.data?.errors?.[0]?.message || e.message}`;
    }

    // Locations
    try {
      const { data } = await axios.get('https://api.ebay.com/sell/inventory/v1/location', { headers: h });
      report.locations = (data.locations || []).map(l => ({ key: l.merchantLocationKey, name: l.name }));
    } catch (e) {
      report.locations = `failed: ${e.response?.data?.errors?.[0]?.message || e.message}`;
    }

  } catch (e) {
    report.auth = `failed: ${e.message}`;
  }
  res.json(report);
});

// ── eBay category suggestions ──────────────────────────────────────
router.get('/category-suggestions', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  let token = null;
  try { token = await getAccessToken(); } catch {}
  const catId = await lookupCategory(q, null, token);
  if (catId) return res.json([{ id: catId, name: '', path: '' }]);
  res.json([]);
});

// ── Auto-generate HTML listing description (fully dynamic) ───────────
router.post('/generate-description', async (req, res) => {
  const { title, specs = {}, imageUrls = [], bullets = [], upc, variant } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    // ── Data richness assessment ──────────────────────────────────────
    const cleanSpecs = Object.entries(specs)
      .filter(([k, v]) => v && !['asin','best_sellers_rank','customer_reviews','unspsc_code'].includes(k) && String(v).trim().length > 0)
      .map(([k, v]) => ({ key: k, label: k.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()), value: String(v).trim() }));

    const cleanBullets = bullets
      .map(b => String(b).replace(/[^\x20-\x7E]/g,' ').replace(/<[^>]+>/g,'').trim())
      .filter(b => b.length > 20).slice(0, 8);

    const imgCount   = imageUrls.length;
    const photoRowTarget = Math.min(4, Math.max(2, Math.floor(imgCount / 2)));
    const specCount  = cleanSpecs.length;
    const hasBullets = cleanBullets.length > 0;

    // ── Build Claude prompt with ALL available data ──────────────────
    const specSection = cleanSpecs.length
      ? `\nProduct Specifications (ALL of these must appear in the spec table):\n${cleanSpecs.map(s=>`• ${s.label}: ${s.value}`).join('\n')}`
      : '';
    const bulletSection = hasBullets
      ? `\nAmazon Product Features (USE these as the basis for photo rows and feature cards):\n${cleanBullets.map((b,i)=>`${i+1}. ${b}`).join('\n')}`
      : '';
    const extraSection = [
      upc ? `UPC/Barcode: ${upc}` : '',
      variant ? `Variant: ${variant}` : '',
    ].filter(Boolean).join('\n');

    const prompt = `You are writing eBay listing HTML description content for a product. Use EVERY piece of data provided — show buyers as much useful information as possible.

Product title: ${title}
Images available: ${imgCount}${extraSection ? `\n${extraSection}` : ''}${specSection}${bulletSection}

Generate a JSON object (raw JSON only, no markdown fences):
{
  "tagline": "Short punchy tagline (max 10 words)",
  "heroSub": "1-2 sentences summarising top benefits (max 25 words)",
  "trustItems": ["badge1","badge2","badge3","badge4","badge5"],
  "features": [
    {"icon":"emoji","title":"Feature name","desc":"2 sentences using real product data"},
    {"icon":"emoji","title":"Feature name","desc":"2 sentences using real product data"},
    {"icon":"emoji","title":"Feature name","desc":"2 sentences using real product data"}
  ],
  "photoRows": [
    {"label":"Feature 01","heading":"Heading","body":"2–3 sentences from product data","bullets":["specific point","specific point","specific point","specific point"]},
    ... generate exactly ${photoRowTarget} photo rows total
  ],
  "ctaHeading": "Compelling CTA headline",
  "ctaSub": "One encouraging sentence",
  "seoText": "2-3 natural readable sentences that describe the product using the keywords buyers actually search for — include product type, material, size/quantity, use cases, and key features as plain prose. Write it for a human reader, not as a keyword list.",
  "theme": "blue|green|orange|navy|teal|red|purple"
}

CRITICAL rules:
- Generate EXACTLY ${photoRowTarget} photoRows
- If Amazon features are provided, base photo rows DIRECTLY on those features — don't invent new ones
- Use SPECIFIC data (numbers, materials, dimensions) not vague language
- seoText must use natural prose — no bullet points, no keyword stuffing, no repetition
- theme: green=natural/bamboo/organic, orange=pest/bug/zapper, blue=fans/water/cooling, navy=car/travel/tech, teal=bathroom/home, red=pest/insect, purple=garden/outdoor
- FORBIDDEN: competitor names, fake reviews, false urgency, external links, HTML tags inside string values`;

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    let content;
    try {
      const raw = (msg.content[0]?.text || '{}')
        .replace(/^```(?:json)?\s*/i,'').replace(/\s*```\s*$/i,'').trim();
      content = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    // ── Color themes ─────────────────────────────────────────────────
    const themes = {
      blue:   { primary:'#0069b4', dk:'#004f8a', accent:'#00a8d4', light:'#e8f5fb', dark:'#0a1f2e', border:'#cde4f0' },
      green:  { primary:'#1a6c1a', dk:'#0f4a0f', accent:'#3aac3a', light:'#e8f8e8', dark:'#0a200a', border:'#b8d8b8' },
      orange: { primary:'#c04010', dk:'#8c2c08', accent:'#e05c1a', light:'#fdf0e8', dark:'#1c0c04', border:'#f0c8a8' },
      navy:   { primary:'#1a2c5a', dk:'#0f1c3a', accent:'#3c6ab4', light:'#eef2fb', dark:'#080e20', border:'#c8d4ea' },
      teal:   { primary:'#0d6e6e', dk:'#084848', accent:'#2a9090', light:'#e5f4f4', dark:'#041c1c', border:'#a8d8d8' },
      red:    { primary:'#b01020', dk:'#800010', accent:'#e05060', light:'#fdf0f0', dark:'#1c0408', border:'#f0b8c0' },
      purple: { primary:'#5a2090', dk:'#3c1468', accent:'#8a40d0', light:'#f4eeff', dark:'#100820', border:'#d0b8f0' },
    };
    const t = themes[content.theme] || themes.blue;

    const f  = content.features  || [];
    const pr = content.photoRows || [];
    const tr = content.trustItems || [];

    // ── Dynamic photo rows (use sequential images) ────────────────────
    const photoRowsHtml = pr.map((row, i) => {
      const imgUrl = imageUrls[i + 1] || imageUrls[i] || '';
      const even = i % 2 === 1;
      return `<div class="pr"${even ? ' style="flex-direction:row-reverse"' : ''}>
<div class="pc">${imgUrl ? `<img src="${imgUrl}" alt="${esc(row.heading||'')}">` : ''}</div>
<div class="tc"><p class="lbl">${esc(row.label||`Feature 0${i+1}`)}</p>
<h3>${esc(row.heading||'')}</h3><p>${esc(row.body||'')}</p>
${(row.bullets||[]).length ? `<ul>${row.bullets.map(b=>`<li>${esc(b)}</li>`).join('')}</ul>` : ''}
</div></div>`;
    }).join('');

    // ── Gallery: images not used in photo rows ────────────────────────
    const galleryImgs = imageUrls.slice(pr.length + 1);
    const galleryHtml = galleryImgs.length
      ? `<div class="gal">${galleryImgs.map(u=>`<img src="${u}" alt="">`).join('')}</div>` : '';

    // ── Complete spec table — ALL specs + UPC + variant + condition ───
    const allSpecRows = [
      ...cleanSpecs.map(s => `<tr><td class="sk">${esc(s.label)}</td><td>${esc(s.value)}</td></tr>`),
      upc     ? `<tr><td class="sk">UPC / Barcode</td><td>${esc(upc)}</td></tr>` : '',
      variant ? `<tr><td class="sk">Variant</td><td>${esc(variant)}</td></tr>` : '',
      `<tr><td class="sk">Condition</td><td>New</td></tr>`,
    ].filter(Boolean).join('');

    const specTableHtml = allSpecRows
      ? `<div class="sh"><h2>Full Product Specifications</h2><div class="div"></div></div>
<div class="ss"><table class="st"><tr><th colspan="2">Technical Details</th></tr>${allSpecRows}</table></div>` : '';

    // ── HTML ──────────────────────────────────────────────────────────
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;background:#fff;max-width:900px;margin:0 auto}
.hero{background:${t.dark};text-align:center;padding:0 0 32px}
.hero img{width:100%;max-height:520px;object-fit:contain;background:${t.dark};display:block}
.hero-text{padding:26px 24px 0}
.hero-tag{display:inline-block;background:${t.accent};color:#fff;font-family:Georgia,serif;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;padding:5px 16px;border-radius:20px;margin-bottom:14px}
.hero-title{font-family:Georgia,serif;font-size:24px;font-weight:bold;color:#fff;line-height:1.35;margin-bottom:10px}
.hero-sub{font-size:14px;color:rgba(255,255,255,0.72);line-height:1.65;max-width:660px;margin:0 auto}
.trust-bar{background:${t.primary};display:flex;flex-wrap:wrap;justify-content:center}
.ti{display:flex;align-items:center;gap:6px;color:#fff;font-size:12px;font-weight:bold;padding:12px 18px;border-right:1px solid rgba(255,255,255,0.2)}
.ti:last-child{border-right:none}
.sh{text-align:center;padding:34px 20px 12px}
.sh h2{font-family:Georgia,serif;font-size:21px;color:${t.dk};margin-bottom:6px}
.div{width:44px;height:3px;background:${t.accent};margin:8px auto 0;border-radius:2px}
.fg{display:flex;flex-wrap:wrap;gap:14px;padding:18px 16px 32px;justify-content:center}
.fc{flex:1 1 230px;max-width:270px;background:${t.light};border:1px solid ${t.border};border-radius:10px;padding:20px 16px;text-align:center}
.fi{font-size:32px;margin-bottom:8px;display:block}
.fc h3{font-family:Georgia,serif;font-size:14px;color:${t.dk};margin-bottom:6px}
.fc p{font-size:13px;color:#555;line-height:1.5}
.pr{display:flex;flex-wrap:wrap;align-items:center;border-bottom:1px solid ${t.border}}
.pc{flex:1 1 300px}
.pc img{width:100%;height:300px;object-fit:contain;background:${t.light};display:block}
.tc{flex:1 1 280px;padding:28px 24px}
.lbl{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${t.accent};font-weight:bold;margin-bottom:6px}
.tc h3{font-family:Georgia,serif;font-size:19px;color:${t.dk};margin-bottom:10px;line-height:1.3}
.tc p{font-size:14px;color:#555;line-height:1.6;margin-bottom:8px}
.tc ul{padding-left:16px;margin-top:6px}
.tc ul li{font-size:13px;color:#555;line-height:1.55;margin-bottom:4px}
.gal{display:flex;flex-wrap:wrap;gap:5px;padding:14px;background:${t.light}}
.gal img{flex:1 1 150px;height:145px;object-fit:contain;background:#fff;border:1px solid ${t.border};border-radius:6px}
.ss{padding:0 14px 30px}
.st{width:100%;border-collapse:collapse;font-size:14px}
.st th{background:${t.dk};color:#fff;font-family:Georgia,serif;padding:11px 14px;text-align:left;font-size:15px}
.st td{padding:9px 14px;border-bottom:1px solid ${t.border};vertical-align:top}
.st tr:nth-child(even) td{background:${t.light}}
.sk{color:#555;width:38%;font-weight:bold}
.cta{background:linear-gradient(135deg,${t.dk},${t.primary},${t.accent});text-align:center;padding:38px 20px}
.cta h2{font-family:Georgia,serif;font-size:23px;color:#fff;margin-bottom:9px}
.cta p{font-size:14px;color:rgba(255,255,255,0.82);margin-bottom:18px;line-height:1.55}
.cb{display:flex;flex-wrap:wrap;justify-content:center;gap:10px}
.cbb{background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.3);color:#fff;font-size:12px;font-weight:bold;padding:8px 18px;border-radius:22px}
.ft{background:#f4f4f4;border-top:2px solid ${t.border};padding:16px;text-align:center;font-size:12px;color:#888;line-height:1.65}
.kw{padding:14px 20px 4px;font-size:12px;color:#aaa;line-height:1.7;text-align:center;max-width:820px;margin:0 auto}
</style></head><body>
<div class="hero">${imageUrls[0]?`<img src="${imageUrls[0]}" alt="${esc(title)}">`:''}<div class="hero-text">
<span class="hero-tag">${esc(content.tagline||'')}</span>
<h1 class="hero-title">${esc(title)}</h1>
<p class="hero-sub">${esc(content.heroSub||'')}</p></div></div>
<div class="trust-bar">${tr.map(x=>`<div class="ti">&#9989; ${esc(x)}</div>`).join('')}</div>
<div class="sh"><h2>Why Choose This Product?</h2><div class="div"></div></div>
<div class="fg">${f.map(x=>`<div class="fc"><span class="fi">${x.icon||'&#10003;'}</span><h3>${esc(x.title)}</h3><p>${esc(x.desc)}</p></div>`).join('')}</div>
${photoRowsHtml}
${galleryHtml}
${specTableHtml}
<div class="cta"><h2>${esc(content.ctaHeading||'Order Today')}</h2><p>${esc(content.ctaSub||'')}</p>
<div class="cb">${tr.slice(0,4).map(x=>`<span class="cbb">&#10003; ${esc(x)}</span>`).join('')}</div></div>
${content.seoText ? `<p class="kw">${esc(content.seoText)}</p>` : ''}
<div class="ft"><p>All images shown are of the actual item. Colour may vary slightly due to monitor settings.</p></div>
</body></html>`;

    console.log(`generate-description: ${pr.length} photo rows, ${cleanSpecs.length} specs, ${cleanBullets.length} bullets, ${imgCount} images`);
    res.json({ html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SEO title generation ───────────────────────────────────────────
router.post('/seo-title', async (req, res) => {
  const { title, specs } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const specLines = specs
      ? Object.entries(specs)
          .filter(([k, v]) => v && !['asin', 'best_sellers_rank', 'customer_reviews', 'brand_name', 'manufacturer'].includes(k))
          .slice(0, 12)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('; ')
      : '';

    const prompt = `Generate an SEO-optimized eBay listing title for this product.

Amazon title: ${title}${specLines ? `\nKey specs: ${specLines}` : ''}

Rules:
- MUST be 75 characters or less — never exceed this, titles that run long get cut off
- Must end on a complete word — never cut mid-word or mid-phrase
- Word order matters: put the highest-search-volume keyword FIRST (usually material + product type, e.g. "Bamboo Cutting Board Set")
- Structure: [Material/Type] [Product Name] [Quantity/Size] [Variant: color or style] [Key Feature] [Use Case]
- If a color or style variant is present in the specs, place it early (3rd or 4th word)
- Include quantity (e.g. "3 Piece", "4 Pack") if present — buyers filter by this
- Use buyer search language: prefer "Butcher Block" over "chopping board" for wood boards, "Rechargeable" over "battery-powered", etc.
- Title Case
- No hyphens, pipes, or special characters — use spaces only
- NEVER include the brand name — buyers search for product type, not brand; drop it entirely
- No "100%", no asterisks, no "best", no exclamation marks, no "free shipping", no "warranty"
- Output ONLY the title, no quotes, no explanation`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    });

    let generated = (message.content[0]?.text || '').trim().replace(/^["']|["']$/g, '');
    // Hard cap at 80 chars (eBay limit), trim to last complete word
    if (generated.length > 80) {
      generated = generated.slice(0, 80).replace(/\s+\S*$/, '').trimEnd();
    }

    res.json({ title: generated || title.slice(0, 80) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sold listings (profit research) ───────────────────────────────
// ── Active competitor prices (Browse API — higher limits than Finding API) ──
router.get('/competitors', async (req, res) => {
  const { upc, title } = req.query;
  if (!upc && !title) return res.status(400).json({ error: 'upc or title required' });

  const cacheKey = `comp:${upc || title}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Application token — same pattern as getValidAspectValues
    const { data: appToken } = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }),
      { headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
    );
    const h = { Authorization: `Bearer ${appToken.access_token}` };

    let items = [];

    // Try GTIN/UPC first (exact match)
    if (upc) {
      try {
        const { data } = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
          params: { gtin: upc, filter: 'conditions:{NEW},buyingOptions:{FIXED_PRICE}', sort: 'price', limit: 20 },
          headers: h, timeout: 8000,
        });
        items = data.itemSummaries || [];
      } catch {}
    }

    // Fall back to keyword search
    if (!items.length && title) {
      const q = title.split(' ').slice(0, 6).join(' ');
      const { data } = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
        params: { q, filter: 'conditions:{NEW},buyingOptions:{FIXED_PRICE}', sort: 'price', limit: 20 },
        headers: h, timeout: 8000,
      });
      items = data.itemSummaries || [];
    }

    const prices = items
      .map(item => parseFloat(item.price?.value || 0))
      .filter(p => p >= 3)  // exclude obvious noise (broken listings, unrelated items)
      .sort((a, b) => a - b);

    if (!prices.length) {
      const empty = { count: 0, lowest: null, median: null, avg: null };
      setCache(cacheKey, empty);
      return res.json(empty);
    }

    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 !== 0
      ? prices[mid]
      : Math.round(((prices[mid - 1] + prices[mid]) / 2) * 100) / 100;

    const result = {
      count: prices.length,
      lowest: prices[0],
      median,
      avg: Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100,
    };
    setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: ebayError(err) });
  }
});

router.get('/sold', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  if (!process.env.EBAY_APP_ID) return res.status(500).json({ error: 'EBAY_APP_ID not set' });

  const cached = getCached(q);
  if (cached) return res.json(cached);

  try {
    const { data } = await axios.get('https://svcs.ebay.com/services/search/FindingService/v1', {
      params: {
        'OPERATION-NAME': 'findCompletedItems',
        'SERVICE-VERSION': '1.0.0',
        'SECURITY-APPNAME': process.env.EBAY_APP_ID,
        'RESPONSE-DATA-FORMAT': 'JSON',
        keywords: q,
        'paginationInput.entriesPerPage': 20,
        'itemFilter(0).name': 'SoldItemsOnly',
        'itemFilter(0).value': 'true',
        sortOrder: 'EndTimeSoonest',
      },
    });

    const items = data.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
    const prices = items
      .map(item => parseFloat(item.sellingStatus?.[0]?.convertedCurrentPrice?.[0]?.__value__ || 0))
      .filter(p => p > 0);

    if (!prices.length) {
      const empty = { count: 0, avg: null };
      setCache(q, empty);
      return res.json(empty);
    }

    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const result = {
      count: prices.length,
      avg: Math.round(avg * 100) / 100,
      min: Math.min(...prices),
      max: Math.max(...prices),
    };
    setCache(q, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: ebayError(err) });
  }
});

// ── Debug: raw GetMyeBaySelling section lengths + samples ──────────
router.get('/selling-limits/debug', async (req, res) => {
  try {
    const token = await getAccessToken();
    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        ${creds}
        <ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></ActiveList>
        <SoldList><Include>true</Include><DurationInDays>31</DurationInDays><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></SoldList>
        <UnsoldList><Include>true</Include><DurationInDays>31</DurationInDays><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></UnsoldList>
      </GetMyeBaySellingRequest>`;
    const { data: xmlResp } = await axios.post('https://api.ebay.com/ws/api.dll', xml, {
      headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' },
    });
    const activeSection = xmlResp.match(/<ActiveList>([\s\S]*?)<\/ActiveList>/)?.[1] || '';
    const soldSection   = xmlResp.match(/<SoldList>([\s\S]*?)<\/SoldList>/)?.[1] || '';
    const unsoldSection = xmlResp.match(/<UnsoldList>([\s\S]*?)<\/UnsoldList>/)?.[1] || '';
    const activeItems   = [...activeSection.matchAll(/<Item>([\s\S]*?)<\/Item>/g)];
    const soldTxs       = [...soldSection.matchAll(/<Transaction>([\s\S]*?)<\/Transaction>/g)];
    const unsoldItems   = [...unsoldSection.matchAll(/<Item>([\s\S]*?)<\/Item>/g)];
    // Per-item breakdown for active listings
    const activeBreakdown = activeItems.map(([,b]) => {
      const itemId = b.match(/<ItemID>(\d+)<\/ItemID>/)?.[1] || '?';
      const vars = [...b.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)];
      const qty = parseInt(b.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] || '0');
      const sold = parseInt(b.match(/<QuantitySold>(\d+)<\/QuantitySold>/)?.[1] || '0');
      const varQtys = vars.map(([,v]) => parseInt(v.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] || '0') + parseInt(v.match(/<QuantitySold>(\d+)<\/QuantitySold>/)?.[1] || '0'));
      return { itemId, hasVariations: vars.length > 0, varCount: vars.length, qty, sold, varQtys };
    });
    const unsoldBreakdown = unsoldItems.map(([,b]) => {
      const itemId = b.match(/<ItemID>(\d+)<\/ItemID>/)?.[1] || '?';
      const vars = [...b.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)];
      const qty = parseInt(b.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] || '0');
      const startTime = b.match(/<StartTime>([\s\S]*?)<\/StartTime>/)?.[1];
      return { itemId, hasVariations: vars.length > 0, varCount: vars.length, qty, startTime };
    });
    res.json({
      activeItemCount: activeItems.length,
      soldTxCount: soldTxs.length,
      unsoldItemCount: unsoldItems.length,
      activeBreakdown,
      unsoldBreakdown,
      soldItemIds: [...new Set(soldTxs.map(([,b]) => b.match(/<ItemID>(\d+)<\/ItemID>/)?.[1]).filter(Boolean))],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Monthly selling limits usage ──────────────────────────────────
router.get('/selling-limits', async (req, res) => {
  try {
    const token = await getAccessToken();

    // Fetch SGD → USD rate (Frankfurter is free, no key needed)
    let sgdToUsd = 0.74;
    try {
      const { data: fx } = await axios.get('https://api.frankfurter.app/latest?from=SGD&to=USD', { timeout: 5000 });
      sgdToUsd = fx.rates?.USD || 0.74;
    } catch {}

    // Monthly limits (configurable via env, sensible defaults from user's account)
    const itemLimit    = parseInt(process.env.EBAY_ITEM_LIMIT       || '200');
    const revLimitSgd  = parseFloat(process.env.EBAY_REVENUE_LIMIT_SGD || '8958.60');

    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

    // Fetch active + sold + unsold(ended) listings for this month
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        ${creds}
        <ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></ActiveList>
        <SoldList><Include>true</Include><DurationInDays>31</DurationInDays><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></SoldList>
        <UnsoldList><Include>true</Include><DurationInDays>31</DurationInDays><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></UnsoldList>
      </GetMyeBaySellingRequest>`;

    const { data: xmlResp } = await axios.post('https://api.ebay.com/ws/api.dll', xml, {
      headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' },
    });

    // eBay counts 1 per variation (not qty × variations). Parse each section separately:
    // ActiveList = currently listed, SoldList = sold & ended, UnsoldList = ended with no sales.
    let totalQtyListed = 0;
    let soldRevenueUsd = 0;
    let soldCount = 0;
    const activeItemIds = new Set();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    // 1. Active listings: count qty per variation (eBay counts available + sold quantity per slot)
    const activeSection = xmlResp.match(/<ActiveList>([\s\S]*?)<\/ActiveList>/)?.[1] || '';
    for (const [, block] of [...activeSection.matchAll(/<Item>([\s\S]*?)<\/Item>/g)]) {
      const itemId = block.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];
      if (itemId) activeItemIds.add(itemId);
      const varBlocks = [...block.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)];
      if (varBlocks.length) {
        for (const [, vb] of varBlocks) {
          const qty  = parseInt(vb.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] || '0');
          const sold = parseInt(vb.match(/<QuantitySold>(\d+)<\/QuantitySold>/)?.[1] || '0');
          totalQtyListed += qty + sold;
          soldCount += sold;
          if (sold) {
            const price = parseFloat(vb.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || '0');
            soldRevenueUsd += price * sold;
          }
        }
      } else {
        const qty  = parseInt(block.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] || '0');
        const sold = parseInt(block.match(/<QuantitySold>(\d+)<\/QuantitySold>/)?.[1] || '0');
        totalQtyListed += qty + sold;
        soldCount += sold;
        if (sold) {
          const price = parseFloat(block.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || '0');
          soldRevenueUsd += price * sold;
        }
      }
    }

    // 2. Sold & ended listings not in active list: count 1 per unique item (sold transactions)
    const soldSection = xmlResp.match(/<SoldList>([\s\S]*?)<\/SoldList>/)?.[1] || '';
    const countedSoldIds = new Set();
    for (const [, tx] of [...soldSection.matchAll(/<Transaction>([\s\S]*?)<\/Transaction>/g)]) {
      const itemId = tx.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];
      if (!itemId || activeItemIds.has(itemId) || countedSoldIds.has(itemId)) continue;
      const dateStr = tx.match(/<CreatedDate>([\s\S]*?)<\/CreatedDate>/)?.[1];
      if (dateStr && new Date(dateStr) < monthStart) continue;
      countedSoldIds.add(itemId);
      totalQtyListed += 1;
    }

    // 3. Unsold/ended listings: count 1 per variation (eBay counts slots used, not qty)
    const unsoldSection = xmlResp.match(/<UnsoldList>([\s\S]*?)<\/UnsoldList>/)?.[1] || '';
    for (const [, block] of [...unsoldSection.matchAll(/<Item>([\s\S]*?)<\/Item>/g)]) {
      const itemId = block.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];
      if (!itemId || activeItemIds.has(itemId)) continue;
      const startTime = block.match(/<StartTime>([\s\S]*?)<\/StartTime>/)?.[1];
      if (startTime && new Date(startTime) < monthStart) continue;
      const varBlocks = [...block.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)];
      totalQtyListed += varBlocks.length || 1; // 1 per variation; 1 for single-item
    }


    const usedItems = totalQtyListed;
    const revLimitUsd = revLimitSgd * sgdToUsd;

    // Try Finances API for accurate revenue (requires sell.finances scope — granted after reconnect)
    let usedRevUsd = soldRevenueUsd; // fallback: estimate from active listing QuantitySold
    let revenueSource = 'estimated';
    try {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const finRes = await axios.get(
        `https://api.ebay.com/sell/finances/v1/transaction?transaction_type=SALE&transaction_date_range.from=${monthStart}&limit=200`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
      );
      if (finRes.data?.transactions?.length >= 0) {
        usedRevUsd = (finRes.data.transactions || []).reduce((sum, tx) => {
          const amt = parseFloat(tx.amount?.value || '0');
          // Convert to USD if in SGD
          if (tx.amount?.currency === 'SGD') return sum + amt * sgdToUsd;
          return sum + amt;
        }, 0);
        revenueSource = 'live';
      }
    } catch { /* sell.finances scope not yet granted — use estimate from QuantitySold */ }

    console.log(`selling-limits: ${usedItems} items, $${usedRevUsd.toFixed(2)} revenue (${revenueSource})`);

    res.json({
      items:   { used: usedItems, limit: itemLimit, remaining: Math.max(0, itemLimit - usedItems) },
      revenue: {
        usedUsd: Math.round(usedRevUsd * 100) / 100,
        limitUsd: Math.round(revLimitUsd * 100) / 100,
        remaining: Math.round(Math.max(0, revLimitUsd - usedRevUsd) * 100) / 100,
        rate: sgdToUsd,
        source: revenueSource,
      },
    });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message });
  }
});

// ── All active listings via Trading API (includes manually created) ─
router.get('/all-active-listings', async (req, res) => {
  try {
    const token = await getAccessToken();

    const xml = `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ActiveList><Include>true</Include><Pagination><EntriesPerPage>100</EntriesPerPage></Pagination></ActiveList></GetMyeBaySellingRequest>`;

    const { data: xmlResp } = await axios.post('https://api.ebay.com/ws/api.dll', xml, {
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml',
      },
    });

    if (/<Ack>Failure<\/Ack>/.test(xmlResp)) {
      const msg = xmlResp.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1] || 'eBay error';
      console.error('all-active-listings Trading API failure:', msg);
      // Missing sell.item scope → tell the client so they can show a reconnect prompt
      return res.status(403).json({ error: 'needs_reconnect', message: msg });
    }

    const items = [];
    const itemRe = /<Item>([\s\S]*?)<\/Item>/g;
    let m;
    while ((m = itemRe.exec(xmlResp)) !== null) {
      const block = m[1];
      const get = tag => {
        const tm = block.match(new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`));
        return tm ? tm[1].trim() : null;
      };
      const listingId = get('ItemID');
      if (!listingId) continue;
      items.push({
        listingId,
        title: get('Title') || listingId,
        price: parseFloat(get('StartPrice') || get('BuyItNowPrice') || '0') || 0,
        currency: 'USD',
        quantity: parseInt(get('QuantityAvailable') || get('Quantity') || '1', 10),
        image: get('GalleryURL') || null,
        url: `https://www.ebay.com/itm/${listingId}`,
      });
    }

    res.json(items);
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    console.error('all-active-listings error:', err.response?.data || err.message);
    res.json([]); // Fail gracefully — don't break the page
  }
});

// ── Update price — Inventory API offer ────────────────────────────
router.patch('/offer/:offerId/price', async (req, res) => {
  try {
    const token = await getAccessToken();
    const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Language': 'en-US' };
    const { offerId } = req.params;
    const { price } = req.body;
    if (!price || isNaN(Number(price)) || Number(price) <= 0)
      return res.status(400).json({ error: 'price is required and must be > 0' });

    const { data: offer } = await axios.get(
      `https://api.ebay.com/sell/inventory/v1/offer/${offerId}`, { headers: h }
    );

    await axios.put(
      `https://api.ebay.com/sell/inventory/v1/offer/${offerId}`,
      {
        availableQuantity: offer.availableQuantity,
        listingPolicies: offer.listingPolicies,
        merchantLocationKey: offer.merchantLocationKey,
        pricingSummary: { price: { value: Number(price).toFixed(2), currency: offer.pricingSummary?.price?.currency || 'USD' } },
        ...(offer.categoryId ? { categoryId: offer.categoryId } : {}),
      },
      { headers: h }
    );

    await axios.post(`https://api.ebay.com/sell/inventory/v1/offer/${offerId}/publish`, {}, { headers: h });
    res.json({ ok: true });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    const ebayErrs = err.response?.data?.errors;
    res.status(500).json({ error: ebayErrs?.length ? ebayErrs.map(e => e.longMessage || e.message).join(' | ') : (err.message || 'Failed') });
  }
});

// ── Revise description on an existing listing ──────────────────────
router.post('/listing/:id/revise-description', async (req, res) => {
  try {
    const token = await getAccessToken();
    const cleanId = String(req.params.id).trim().replace(/\D/g, '');
    const { description } = req.body;
    if (!cleanId) return res.status(400).json({ error: 'Invalid listing ID' });
    if (!description) return res.status(400).json({ error: 'description is required' });

    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
    const body = `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
      ${creds}
      <Item>
        <ItemID>${cleanId}</ItemID>
        <Description><![CDATA[${description}]]></Description>
      </Item>
    </ReviseFixedPriceItemRequest>`;

    const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll',
      `<?xml version="1.0" encoding="utf-8"?>${body}`,
      { headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-IAF-TOKEN': token, 'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem', 'Content-Type': 'text/xml' } }
    );

    if (/<Ack>Failure<\/Ack>/.test(xml)) {
      const msg = xml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1] || 'eBay error';
      return res.status(400).json({ error: msg });
    }

    res.json({ ok: true });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message });
  }
});

// ── Update variation photos on an existing multi-variation listing ──
router.post('/listing/variation-photos', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { listingId, variantDimension, variants } = req.body;
    // variants: [{ label, image }]
    if (!listingId || !variants?.length)
      return res.status(400).json({ error: 'listingId and variants required' });

    const cleanId = String(listingId).trim().replace(/\D/g, '');
    if (!cleanId) return res.status(400).json({ error: 'Invalid listing ID' });

    const tradingHeaders = {
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-IAF-TOKEN': token,
      'Content-Type': 'text/xml',
    };
    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

    const withImages = variants.filter(v => v.images?.length || v.image);
    if (!withImages.length) return res.status(400).json({ error: 'No variant images provided' });

    const dimName = variantDimension || 'Style';
    const pictureSets = withImages.map(v => {
      const imgs = v.images?.length ? v.images : (v.image ? [v.image] : []);
      return `<VariationSpecificPictureSet>
        <VariationSpecificValue>${escXml(v.label)}</VariationSpecificValue>
        ${imgs.map(img => `<PictureURL>${escXml(img)}</PictureURL>`).join('')}
      </VariationSpecificPictureSet>`;
    }).join('');

    const body = `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
      ${creds}
      <Item>
        <ItemID>${cleanId}</ItemID>
        <Variations>
          <Pictures>
            <VariationSpecificName>${escXml(dimName)}</VariationSpecificName>
            ${pictureSets}
          </Pictures>
        </Variations>
      </Item>
    </ReviseFixedPriceItemRequest>`;

    const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll',
      `<?xml version="1.0" encoding="utf-8"?>${body}`,
      { headers: { ...tradingHeaders, 'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem' } }
    );

    if (/<Ack>Failure<\/Ack>/.test(xml)) {
      const msg = xml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1]
        || xml.match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/)?.[1]
        || 'eBay error';
      return res.status(400).json({ error: msg });
    }

    console.log(`variation-photos: updated ${withImages.length} variants on listing ${cleanId}`);
    res.json({ ok: true, updated: withImages.length });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message || 'Failed to update variation photos' });
  }
});

// ── Update price — any listing via Trading API ─────────────────────
// Handles both single listings and multi-variation (size/color) listings.
router.post('/listing/price', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { listingId, price, variantLabel } = req.body;
    if (!listingId || !price || isNaN(Number(price)) || Number(price) <= 0)
      return res.status(400).json({ error: 'listingId and price are required' });

    const cleanId = String(listingId).trim().replace(/\D/g, '');
    if (!cleanId) return res.status(400).json({ error: 'Listing ID must be numeric' });

    const priceStr = Number(price).toFixed(2);
    const label = (variantLabel || '').toLowerCase().trim();

    const tradingHeaders = {
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-IAF-TOKEN': token,
      'Content-Type': 'text/xml',
    };
    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

    function tradingPost(callName, body) {
      return axios.post('https://api.ebay.com/ws/api.dll',
        `<?xml version="1.0" encoding="utf-8"?>${body}`,
        { headers: { ...tradingHeaders, 'X-EBAY-API-CALL-NAME': callName } }
      );
    }
    function checkFailure(xml) {
      if (!/<Ack>Failure<\/Ack>/.test(xml) && !/<Ack>PartialFailure<\/Ack>/.test(xml)) return null;
      return xml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1]
        || xml.match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/)?.[1]
        || 'eBay returned an error';
    }

    // GetItem to read current variations
    const { data: getItemXml } = await tradingPost('GetItem',
      `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID></GetItemRequest>`
    );
    const getItemErr = checkFailure(getItemXml);
    if (getItemErr) return res.status(400).json({ error: getItemErr });

    const varBlocks = [];
    const varRe = /<Variation>([\s\S]*?)<\/Variation>/g;
    let vm;
    while ((vm = varRe.exec(getItemXml)) !== null) varBlocks.push(vm[0]);

    console.log(`listing/price: id=${cleanId} label="${label}" price=${priceStr} variations=${varBlocks.length}`);

    if (varBlocks.length === 0) {
      // Single listing — ReviseInventoryStatus is fine here
      const body = `<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<InventoryStatus><ItemID>${cleanId}</ItemID><StartPrice currencyID="USD">${priceStr}</StartPrice></InventoryStatus></ReviseInventoryStatusRequest>`;
      const { data: xml } = await tradingPost('ReviseInventoryStatus', body);
      const err = checkFailure(xml);
      if (err) return res.status(400).json({ error: err });
    } else {
      // Multi-variation — use ReviseFixedPriceItem which works for both SKU-based and
      // non-SKU listings (ReviseInventoryStatus requires the variation SKU for SKU-based
      // listings and fails with "Variation level SKU should be supplied" otherwise).
      // We send ALL variations: update price for matching ones, keep current price for others.
      const variationXml = varBlocks.map(vBlock => {
        const currentPriceM = vBlock.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/);
        const currentPrice = currentPriceM ? parseFloat(currentPriceM[1]).toFixed(2) : priceStr;

        let isMatch = !label; // no label → update all
        if (label) {
          const nvRe = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
          let nv;
          while ((nv = nvRe.exec(vBlock)) !== null) {
            const raw = nv[1].match(/<Value>([\s\S]*?)<\/Value>/)?.[1] || '';
            const val = raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").toLowerCase();
            if (val === label || label.includes(val) || val.includes(label)) { isMatch = true; break; }
          }
        }

        const thisPrice = isMatch ? priceStr : currentPrice;
        const specificsContent = vBlock.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
        const sku = vBlock.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
        const skuXml = sku ? `<SKU>${sku}</SKU>` : '';
        return `<Variation>${skuXml}<StartPrice currencyID="USD">${thisPrice}</StartPrice><VariationSpecifics>${specificsContent}</VariationSpecifics></Variation>`;
      }).join('');

      console.log(`listing/price: id=${cleanId} label="${label}" → ReviseFixedPriceItem (${varBlocks.length} variations)`);
      const body = `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${cleanId}</ItemID><Variations>${variationXml}</Variations></Item></ReviseFixedPriceItemRequest>`;
      const { data: xml } = await tradingPost('ReviseFixedPriceItem', body);
      console.log('listing/price: ReviseFixedPriceItem response:', xml.slice(0, 500));
      const err = checkFailure(xml);
      if (err) return res.status(400).json({ error: err });
    }

    res.json({ ok: true, variations: varBlocks.length });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message || 'Failed to update price' });
  }
});

// ── End (delete) a listing via Trading API (EndFixedPriceItem) ─────────
router.delete('/listing/:id', async (req, res) => {
  try {
    const token = await getAccessToken();
    const cleanId = String(req.params.id).trim().replace(/\D/g, '');
    if (!cleanId) return res.status(400).json({ error: 'Listing ID must be numeric' });

    const tradingHeaders = {
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-IAF-TOKEN': token,
      'Content-Type': 'text/xml',
    };
    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
    const body = `<?xml version="1.0" encoding="utf-8"?><EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID><EndingReason>NotAvailable</EndingReason></EndFixedPriceItemRequest>`;

    const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll', body,
      { headers: { ...tradingHeaders, 'X-EBAY-API-CALL-NAME': 'EndFixedPriceItem' } }
    );

    if (/<Ack>Failure<\/Ack>/.test(xml)) {
      const msg = xml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1]
        || xml.match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/)?.[1]
        || 'eBay returned an error';
      return res.status(400).json({ error: msg });
    }

    res.json({ ok: true });
  } catch (err) {
    if (err.response?.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message || 'Failed to end listing' });
  }
});

// ── Create listing via Trading API (AddFixedPriceItem) ─────────────────
// More reliable than Inventory API for accounts that haven't been approved
// for programmatic listing creation via the Inventory API.
router.post('/trading-create-listing', async (req, res) => {
  try {
    const token = await getAccessToken();
    const {
      title, price, currency = 'USD', quantity = 2,
      condition = 'NEW', categoryId,
      imageUrls = [], upc, specs = {}, bullets = [], description,
      variants, // [{ label, price, quantity }] for multi-variation
      variantDimension = 'Color', // e.g. 'Color', 'Size', 'Style'
      shipping = { free: true, carrier: 'FedExStandardOvernight', handlingDays: 1 },
      returns = { accepted: true, days: 30, buyerPays: true },
      // Seller location — defaults match account registered location
      sellerCountry = 'TH',
      sellerLocation = 'Phayao',
    } = req.body;

    if (!title || !price) return res.status(400).json({ error: 'title and price are required' });

    const safeTitle = sanitizeTitle(title);
    const conditionId = condition === 'NEW' ? '1000' : '3000';

    // Auto-detect category if not provided
    let catId = categoryId ? String(categoryId) : null;
    if (!catId) {
      catId = await lookupCategory(safeTitle, upc);
    }
    if (!catId) return res.status(400).json({ error: 'Could not auto-detect eBay category. Please provide categoryId.' });

    // Build item specifics — use real brand name; retry will fall back to Unbranded if eBay rejects it
    const aspects = buildAspects(specs);
    if (upc && !aspects['UPC']) aspects['UPC'] = [upc];
    if (!aspects['Brand']) aspects['Brand'] = [specs.brand_name || 'Unbranded'];

    // Proactively inject aspects that can be matched from the title (avoids 21919303 on first attempt)
    await injectTitleAspects(catId, aspects, safeTitle);

    // Fill remaining unfilled aspects (required + recommended) using product specs and bullets
    await enrichAspectsWithAI(catId, aspects, safeTitle, specs, bullets);

    // For multi-variation listings, the variantDimension (Color/Size/Style) MUST NOT appear
    // in ItemSpecifics — eBay error 21916626 fires if the same name appears in both.
    if (variants?.length && variantDimension) delete aspects[variantDimension];

    const buildSpecXml = (asp) => Object.entries(asp)
      .map(([name, vals]) => `<NameValueList><Name>${escXml(name)}</Name>${vals.map(v => `<Value>${escXml(String(v))}</Value>`).join('')}</NameValueList>`)
      .join('');

    // Build pictures XML (max 12)
    const pics = imageUrls.slice(0, 12);
    const picturesXml = pics.length
      ? `<PictureDetails>${pics.map(u => `<PictureURL>${escXml(u)}</PictureURL>`).join('')}</PictureDetails>`
      : '';

    // Fetch seller's business policies (required when seller has opted into policy management)
    const h = { Authorization: `Bearer ${token}` };
    const mid = 'EBAY_US';
    let fulfillmentPolicyId = null;
    let returnPolicyId = null;
    let paymentPolicyId = null;
    try {
      const [fulRes, retRes, payRes] = await Promise.all([
        axios.get(`https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=${mid}`, { headers: h }),
        axios.get(`https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=${mid}`, { headers: h }),
        axios.get(`https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=${mid}`, { headers: h }),
      ]);
      // Prefer the "USA Buyer" fulfillment policy, else fall back to first available
      const fuls = fulRes.data.fulfillmentPolicies || [];
      const usaBuyer = fuls.find(p => /usa.?buyer/i.test(p.name));
      fulfillmentPolicyId = (usaBuyer || fuls[0])?.fulfillmentPolicyId || null;

      const rets = retRes.data.returnPolicies || [];
      const returnsAccepted = rets.find(p => /return.*accept|30d/i.test(p.name));
      returnPolicyId = (returnsAccepted || rets[0])?.returnPolicyId || null;

      const pays = payRes.data.paymentPolicies || [];
      paymentPolicyId = pays[0]?.paymentPolicyId || null;
    } catch { /* proceed without business policies — eBay may accept inline */ }

    const sellerProfilesXml = fulfillmentPolicyId
      ? `<SellerProfiles>
          <SellerShippingProfile><ShippingProfileID>${fulfillmentPolicyId}</ShippingProfileID></SellerShippingProfile>
          <SellerReturnProfile>${returnPolicyId ? `<ReturnProfileID>${returnPolicyId}</ReturnProfileID>` : ''}</SellerReturnProfile>
          ${paymentPolicyId ? `<SellerPaymentProfile><PaymentProfileID>${paymentPolicyId}</PaymentProfileID></SellerPaymentProfile>` : ''}
        </SellerProfiles>`
      : '';

    // Inline shipping/return as fallback when no business policies found
    const shipCost = shipping.free ? '0.00' : Number(shipping.cost || 0).toFixed(2);
    const inlineShippingXml = fulfillmentPolicyId ? '' : `<ShippingDetails>
      <ShippingType>Flat</ShippingType>
      <ShippingServiceOptions>
        <ShippingServicePriority>1</ShippingServicePriority>
        <ShippingService>${escXml(shipping.carrier || 'FedExStandardOvernight')}</ShippingService>
        <ShippingServiceCost currencyID="USD">${shipCost}</ShippingServiceCost>
      </ShippingServiceOptions>
    </ShippingDetails>`;

    const inlineReturnXml = (fulfillmentPolicyId || !returns.accepted) ? '' : `<ReturnPolicy>
      <ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption>
      <RefundOption>MoneyBack</RefundOption>
      <ReturnsWithinOption>Days_${returns.days || 30}</ReturnsWithinOption>
      <ShippingCostPaidByOption>${returns.buyerPays ? 'Buyer' : 'Seller'}</ShippingCostPaidByOption>
    </ReturnPolicy>`;

    // Description
    const desc = description || buildDescription();

    const tradingHeaders = {
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-IAF-TOKEN': token,
      'Content-Type': 'text/xml',
    };
    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

    function tradingPost(callName, body) {
      return axios.post('https://api.ebay.com/ws/api.dll',
        `<?xml version="1.0" encoding="utf-8"?>${body}`,
        { headers: { ...tradingHeaders, 'X-EBAY-API-CALL-NAME': callName } }
      );
    }

    // Multi-variation XML block (built once, reused in buildBody)
    let varSpecsXml = '';
    if (variants?.length) {
      const variationsXml = variants.map(v => {
        const varPrice = v.price || price;
        return `<Variation>
          <StartPrice currencyID="USD">${Number(varPrice).toFixed(2)}</StartPrice>
          <Quantity>${Number(v.quantity) || 2}</Quantity>
          <VariationSpecifics>
            <NameValueList><Name>${escXml(variantDimension)}</Name><Value>${escXml(v.label)}</Value></NameValueList>
          </VariationSpecifics>
        </Variation>`;
      }).join('');

      // Per-variant pictures — all images per variant, changes on selection
      const variantsWithImages = variants.filter(v => v.images?.length || v.image);
      const variationPicturesXml = variantsWithImages.length ? `
        <Pictures>
          <VariationSpecificName>${escXml(variantDimension)}</VariationSpecificName>
          ${variantsWithImages.map(v => {
            const imgs = v.images?.length ? v.images : (v.image ? [v.image] : []);
            return `<VariationSpecificPictureSet>
            <VariationSpecificValue>${escXml(v.label)}</VariationSpecificValue>
            ${imgs.map(img => `<PictureURL>${escXml(img)}</PictureURL>`).join('')}
          </VariationSpecificPictureSet>`;
          }).join('')}
        </Pictures>` : '';

      varSpecsXml = `<Variations>
        ${variationsXml}
        <VariationSpecificsSet>
          <NameValueList>
            <Name>${escXml(variantDimension)}</Name>
            ${variants.map(v => `<Value>${escXml(v.label)}</Value>`).join('')}
          </NameValueList>
        </VariationSpecificsSet>
        ${variationPicturesXml}
      </Variations>`;
    }

    // Build AddFixedPriceItem body — accepts current item specifics so we can retry
    const buildBody = (iSpecXml) => {
      const iSpecBlock = iSpecXml ? `<ItemSpecifics>${iSpecXml}</ItemSpecifics>` : '';
      if (variants?.length) {
        return `<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
          ${creds}
          <Item>
            <Title>${escXml(safeTitle)}</Title>
            <Description><![CDATA[${desc}]]></Description>
            <PrimaryCategory><CategoryID>${catId}</CategoryID></PrimaryCategory>
            <StartPrice currencyID="USD">${Number(price).toFixed(2)}</StartPrice>
            <ConditionID>${conditionId}</ConditionID>
            <Country>${escXml(sellerCountry)}</Country>
            <Currency>USD</Currency>
            <DispatchTimeMax>${Number(shipping.handlingDays) || 1}</DispatchTimeMax>
            <ListingDuration>GTC</ListingDuration>
            <ListingType>FixedPriceItem</ListingType>
            ${picturesXml}
            ${iSpecBlock}
            ${varSpecsXml}
            <Location>${escXml(sellerLocation)}</Location>
            ${sellerProfilesXml}
            ${inlineShippingXml}
            ${inlineReturnXml}
            ${upc ? `<ProductListingDetails><UPC>${escXml(upc)}</UPC></ProductListingDetails>` : ''}
          </Item>
        </AddFixedPriceItemRequest>`;
      } else {
        return `<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
          ${creds}
          <Item>
            <Title>${escXml(safeTitle)}</Title>
            <Description><![CDATA[${desc}]]></Description>
            <PrimaryCategory><CategoryID>${catId}</CategoryID></PrimaryCategory>
            <StartPrice currencyID="USD">${Number(price).toFixed(2)}</StartPrice>
            <ConditionID>${conditionId}</ConditionID>
            <Country>${escXml(sellerCountry)}</Country>
            <Currency>USD</Currency>
            <DispatchTimeMax>${Number(shipping.handlingDays) || 1}</DispatchTimeMax>
            <ListingDuration>GTC</ListingDuration>
            <ListingType>FixedPriceItem</ListingType>
            <Quantity>${Number(quantity)}</Quantity>
            <Location>${escXml(sellerLocation)}</Location>
            ${picturesXml}
            ${iSpecBlock}
            ${sellerProfilesXml}
            ${inlineShippingXml}
            ${inlineReturnXml}
            ${upc ? `<ProductListingDetails><UPC>${escXml(upc)}</UPC></ProductListingDetails>` : ''}
          </Item>
        </AddFixedPriceItemRequest>`;
      }
    };

    // First attempt
    let xml;
    ({ data: xml } = await tradingPost('AddFixedPriceItem', buildBody(buildSpecXml(aspects))));

    // 21916564 — category doesn't support multi-variation: strip variants and retry as single listing
    if (!/<ItemID>\d+<\/ItemID>/.test(xml) && /<ErrorCode>21916564<\/ErrorCode>/.test(xml) && variants?.length) {
      console.log(`trading-create-listing: 21916564 for "${safeTitle}" — retrying as single listing (no variants)`);
      varSpecsXml = ''; // remove multi-variation structure
      const firstVariant = variants[0];
      const singleQty = Number(firstVariant?.quantity || quantity);
      // Rebuild body without variants
      const buildSingleBody = (iSpecXml) => {
        const iSpecBlock = iSpecXml ? `<ItemSpecifics>${iSpecXml}</ItemSpecifics>` : '';
        return `<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
          ${creds}
          <Item>
            <Title>${escXml(safeTitle)}</Title>
            <Description><![CDATA[${desc}]]></Description>
            <PrimaryCategory><CategoryID>${catId}</CategoryID></PrimaryCategory>
            <StartPrice currencyID="USD">${Number(price).toFixed(2)}</StartPrice>
            <ConditionID>${conditionId}</ConditionID>
            <Country>${escXml(sellerCountry)}</Country>
            <Currency>USD</Currency>
            <DispatchTimeMax>${Number(shipping.handlingDays) || 1}</DispatchTimeMax>
            <ListingDuration>GTC</ListingDuration>
            <ListingType>FixedPriceItem</ListingType>
            <Quantity>${singleQty}</Quantity>
            <Location>${escXml(sellerLocation)}</Location>
            ${picturesXml}
            ${iSpecBlock}
            ${sellerProfilesXml}
            ${inlineShippingXml}
            ${inlineReturnXml}
            ${upc ? `<ProductListingDetails><UPC>${escXml(upc)}</UPC></ProductListingDetails>` : ''}
          </Item>
        </AddFixedPriceItemRequest>`;
      };
      ({ data: xml } = await tradingPost('AddFixedPriceItem', buildSingleBody(buildSpecXml(aspects))));
    }

    // Retry once if eBay reports missing item specifics (21919303) and no ItemID yet
    if (!/<ItemID>\d+<\/ItemID>/.test(xml)) {
      const missingFields = [];
      const r21 = /<Errors>([\s\S]*?)<\/Errors>/g;
      let m21;
      while ((m21 = r21.exec(xml)) !== null) {
        if (/<ErrorCode>21919303<\/ErrorCode>/.test(m21[1])) {
          const f = m21[1].match(/item specific ([^\s.]+) is missing/i)?.[1];
          if (f && !missingFields.includes(f)) missingFields.push(f);
        }
      }
      if (missingFields.length) {
        const catAspects = await getValidAspectValues(catId);
        for (const f of missingFields) {
          if (f === 'Brand') {
            aspects[f] = ['Unbranded'];
          } else {
            const info = catAspects[f] || { values: [] };
            const matched = matchAspectValue(info.values, safeTitle);
            if (matched) {
              aspects[f] = [matched];
            } else if (info.values.length) {
              const best = await pickBestAspectValue(f, info.values, safeTitle);
              if (best) aspects[f] = [best];
            }
          }
        }
        // Never let variantDimension sneak back into ItemSpecifics during retry
        if (variants?.length && variantDimension) delete aspects[variantDimension];
        console.log('trading-create-listing: retry specifics:', JSON.stringify(Object.fromEntries(missingFields.map(f => [f, aspects[f]]))));
        ({ data: xml } = await tradingPost('AddFixedPriceItem', buildBody(buildSpecXml(aspects))));
      }
    }

    // Extract ItemID first — present on Success, Warning, and PartialFailure (warnings-only)
    const listingId = xml.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];

    if (/<Ack>Failure<\/Ack>/.test(xml) || (/<Ack>PartialFailure<\/Ack>/.test(xml) && !listingId)) {
      const allMsgs = [];
      const errRe = /<Errors>([\s\S]*?)<\/Errors>/g;
      let em;
      while ((em = errRe.exec(xml)) !== null) {
        const sev = em[1].match(/<SeverityCode>([^<]+)<\/SeverityCode>/)?.[1] || '';
        if (sev === 'Warning') continue; // skip non-fatal warnings
        const code = em[1].match(/<ErrorCode>([^<]+)<\/ErrorCode>/)?.[1] || '';
        const long = em[1].match(/<LongMessage>([^<]+)<\/LongMessage>/)?.[1] || '';
        const short = em[1].match(/<ShortMessage>([^<]+)<\/ShortMessage>/)?.[1] || '';
        allMsgs.push(`[${code}] ${long || short}`);
      }
      const msg = allMsgs.join(' | ') || xml.slice(0, 600);
      console.error('trading-create-listing failure XML:\n', xml.slice(0, 1200));
      return res.status(400).json({ error: msg });
    }

    if (!listingId) return res.status(500).json({ error: 'Listing created but could not extract ItemID', raw: xml.slice(0, 500) });

    res.json({ listingId, url: `https://www.ebay.com/itm/${listingId}` });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message || 'Failed to create listing' });
  }
});

function escXml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ── API usage stats ────────────────────────────────────────────────────
router.get('/api-usage', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll',
      `<?xml version="1.0" encoding="utf-8"?><GetApiAccessRulesRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials></GetApiAccessRulesRequest>`,
      { headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-CALL-NAME': 'GetApiAccessRules', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' } }
    );
    const rules = [];
    const re = /<ApiAccessRule>([\s\S]*?)<\/ApiAccessRule>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const b = m[1];
      const get = tag => b.match(new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`))?.[1];
      const daily = get('DailyHardLimit');
      const used = get('DailyUsage') || get('PerDayUsage');
      if (daily && used) rules.push({ call: get('CallName'), dailyLimit: parseInt(daily), used: parseInt(used), remaining: parseInt(daily) - parseInt(used) });
    }
    rules.sort((a, b) => b.used - a.used);
    res.json(rules);
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated') return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message });
  }
});

// ── Debug: raw Shopping API response ──────────────────────────────────
router.get('/listing/:id/raw', async (req, res) => {
  const cleanId = String(req.params.id).replace(/\D/g, '');
  try {
    const { data } = await axios.get('https://open.api.ebay.com/shopping', {
      params: {
        callname: 'GetSingleItem',
        responseencoding: 'JSON',
        appid: process.env.EBAY_APP_ID,
        version: '967',
        ItemID: cleanId,
        IncludeSelector: 'Variations',
      },
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, response: err.response?.data });
  }
});

// ── Get live prices for a listing (Trading API GetItem) ───────────────
router.get('/listing/:id/prices', async (req, res) => {
  const cleanId = String(req.params.id).replace(/\D/g, '');
  if (!cleanId) return res.status(400).json({ error: 'Invalid listing ID' });
  try {
    const token = await getAccessToken();
    const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll',
      `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ItemID>${cleanId}</ItemID><IncludeItemSpecifics>true</IncludeItemSpecifics></GetItemRequest>`,
      { headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-CALL-NAME': 'GetItem', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' } }
    );

    if (/<Ack>Failure<\/Ack>/.test(xml)) {
      const msg = xml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1] || 'eBay error';
      return res.status(400).json({ error: msg });
    }

    // Parse base price
    const baseMatch = xml.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/);
    const base = baseMatch ? parseFloat(baseMatch[1]) : 0;

    // Parse variations
    const variations = [];
    const varRe = /<Variation>([\s\S]*?)<\/Variation>/g;
    let m;
    while ((m = varRe.exec(xml)) !== null) {
      const block = m[1];
      const priceMatch = block.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/);
      const price = priceMatch ? parseFloat(priceMatch[1]) : base;
      const specs = {};
      const nvRe = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
      let nv;
      while ((nv = nvRe.exec(block)) !== null) {
        const name = nv[1].match(/<Name>([\s\S]*?)<\/Name>/)?.[1]?.toLowerCase();
        const rawVal = nv[1].match(/<Value>([\s\S]*?)<\/Value>/)?.[1] || '';
        const value = rawVal.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").toLowerCase();
        if (name && value) specs[name] = value;
      }
      variations.push({ price, specs });
    }

    res.json({ base, variations });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message });
  }
});

// ── Get eBay listing view counts (batch — one Analytics API call for all IDs) ──
const viewsCache = new Map(); // listingId → { count, expiresAt }
const VIEWS_TTL = 60 * 60 * 1000; // 1 hour cache

// Batch endpoint: GET /api/ebay/listings/views?ids=id1,id2,id3
// Returns { views: { id1: N, id2: N, ... } }
router.get('/listings/views', async (req, res) => {
  const rawIds = String(req.query.ids || '');
  const ids = [...new Set(rawIds.split(',').map(s => s.replace(/\D/g, '')).filter(Boolean))];
  if (!ids.length) return res.status(400).json({ error: 'ids query param required' });

  const now = new Date();
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  // Return cached results for all IDs that are still fresh
  const result = {};
  const uncached = [];
  for (const id of ids) {
    const cached = viewsCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      result[id] = cached.count;
    } else {
      uncached.push(id);
    }
  }

  if (uncached.length) {
    try {
      const token = await getAccessToken();
      const { data } = await axios.get('https://api.ebay.com/sell/analytics/v1/traffic_report', {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          dimension: 'LISTING',
          metric: 'LISTING_VIEWS_TOTAL',
          filter: `listing_ids:{${uncached.join('|')}},date_range:[${fmt(start)}..${fmt(now)}]`,
        },
      });
      for (const record of (data.records || [])) {
        const lid = String(record.dimensionValues?.[0]?.value || '');
        if (!lid) continue;
        const total = Number(record.metricValues?.[0]?.value ?? 0);
        result[lid] = total;
        viewsCache.set(lid, { count: total, expiresAt: Date.now() + VIEWS_TTL });
      }
      // IDs with no records get 0
      for (const id of uncached) {
        if (result[id] == null) result[id] = 0;
      }
    } catch (apiErr) {
      console.error('[eBay views] Analytics API error:', apiErr.response?.data || apiErr.message);
      for (const id of uncached) result[id] = 0;
      return res.json({ views: result, _error: apiErr.response?.data || apiErr.message });
    }
  }

  res.json({ views: result });
});

// Legacy single-ID endpoint (kept for backwards compat)
router.get('/listing/:id/views', async (req, res) => {
  const cleanId = String(req.params.id).replace(/\D/g, '');
  if (!cleanId) return res.status(400).json({ error: 'Invalid listing ID' });

  const cached = viewsCache.get(cleanId);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ listingId: cleanId, views: cached.count });
  }

  try {
    const token = await getAccessToken();
    const now = new Date();
    const start = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

    let views = 0;
    try {
      const { data } = await axios.get('https://api.ebay.com/sell/analytics/v1/traffic_report', {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          dimension: 'LISTING',
          metric: VIEW_METRICS.join(','),
          filter: `listing_ids:{${cleanId}},date_range:[${fmt(start)}..${fmt(now)}]`,
        },
      });
      for (const record of (data.records || [])) {
        for (const m of (record.metricData || [])) {
          if (VIEW_METRICS.includes(m.metricKey) && m.value != null) views += Number(m.value);
        }
      }
    } catch (apiErr) {
      console.error(`[eBay views] Analytics API error for listing ${cleanId}:`, apiErr.response?.data || apiErr.message);
      return res.json({ listingId: cleanId, views: 0, _error: apiErr.response?.data || apiErr.message });
    }

    viewsCache.set(cleanId, { count: views, expiresAt: Date.now() + VIEWS_TTL });
    res.json({ listingId: cleanId, views });
  } catch (err) {
    if (err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message });
  }
});

// ── Audit + fix return policy and handling time on all listings ────
router.post('/fix-policies', async (req, res) => {
  const token = await getAccessToken();
  const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

  const products = await Product.find({ ebayListingId: { $exists: true, $ne: null } }, 'ebayListingId').lean();
  const ids = [...new Set(products.map(p => p.ebayListingId))];

  const results = await Promise.all(ids.map(async id => {
    const cleanId = id.replace(/\D/g, '');
    try {
      // 1. Check current settings
      const getBody = `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID></GetItemRequest>`;
      const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll', getBody, {
        headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-IAF-TOKEN': token, 'X-EBAY-API-CALL-NAME': 'GetItem', 'Content-Type': 'text/xml' },
        timeout: 10000
      });

      const dispatch = parseInt(xml.match(/<DispatchTimeMax>(\d+)<\/DispatchTimeMax>/)?.[1] ?? '99');
      const returnsAccepted = xml.match(/<ReturnsAcceptedOption>(.*?)<\/ReturnsAcceptedOption>/)?.[1] || '';
      const returnsWithin   = xml.match(/<ReturnsWithinOption>(.*?)<\/ReturnsWithinOption>/)?.[1] || '';

      const needsHandlingFix = dispatch > 1;
      const needsReturnFix   = returnsAccepted !== 'ReturnsAccepted' || !['Days_30', 'Days_60'].includes(returnsWithin);

      if (!needsHandlingFix && !needsReturnFix) {
        return { id, ok: true, fixed: false, dispatch, returnsWithin };
      }

      // 2. Fix
      const newDispatch = needsHandlingFix ? 1 : dispatch;
      const reviseBody = `<?xml version="1.0" encoding="utf-8"?><ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        ${creds}
        <Item>
          <ItemID>${cleanId}</ItemID>
          <DispatchTimeMax>${newDispatch}</DispatchTimeMax>
          <ReturnPolicy>
            <ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption>
            <ReturnsWithinOption>Days_30</ReturnsWithinOption>
            <ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption>
          </ReturnPolicy>
        </Item>
      </ReviseFixedPriceItemRequest>`;

      const { data: revXml } = await axios.post('https://api.ebay.com/ws/api.dll', reviseBody, {
        headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-IAF-TOKEN': token, 'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem', 'Content-Type': 'text/xml' },
        timeout: 10000
      });

      const ok = !/<Ack>Failure<\/Ack>/.test(revXml);
      const errMsg = revXml.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] || '';
      return { id, ok, fixed: ok, dispatch: newDispatch, returnsWithin: 'Days_30', error: ok ? null : errMsg };
    } catch (e) {
      return { id, ok: false, fixed: false, error: e.message };
    }
  }));

  const fixed   = results.filter(r => r.fixed).length;
  const correct = results.filter(r => r.ok && !r.fixed).length;
  const failed  = results.filter(r => !r.ok).length;
  res.json({ total: ids.length, fixed, alreadyCorrect: correct, failed, results });
});

// ── Quick report: fetch current eBay titles for all tracked listings ──
router.get('/listing-titles', async (req, res) => {
  try {
    const token = await getAccessToken();
    const products = await Product.find({ ebayListingId: { $exists: true, $ne: null } }, 'ebayListingId title').lean();
    const ids = [...new Set(products.map(p => p.ebayListingId))];

    const results = await Promise.all(ids.map(async id => {
      try {
        const body = `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ItemID>${id}</ItemID></GetItemRequest>`;
        const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll', body, {
          headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-IAF-TOKEN': token, 'X-EBAY-API-CALL-NAME': 'GetItem', 'Content-Type': 'text/xml' },
          timeout: 10000
        });
        const ok = !/<Ack>Failure<\/Ack>/.test(xml);
        const ebayTitle = xml.match(/<Title>(.*?)<\/Title>/)?.[1] || '';
        const errMsg = xml.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] || '';
        return { id, ok, title: ebayTitle, error: ok ? null : errMsg };
      } catch (e) {
        return { id, ok: false, title: '', error: e.message };
      }
    }));

    const updated = results.filter(r => r.ok).length;
    res.json({ total: ids.length, updated, failed: ids.length - updated, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Batch optimize all existing listings ───────────────────────────
// Regenerates SEO title, item specifics, and description for every
// eBay listing in the DB and pushes via ReviseFixedPriceItem.
router.post('/batch-optimize', async (req, res) => {
  const BASE = `http://localhost:${process.env.PORT || 5000}`;

  const products = await Product.find({ ebayListingId: { $exists: true, $ne: null } }).lean();
  // Group by listingId, pick most-data variant as primary
  const groups = {};
  for (const p of products) {
    if (!groups[p.ebayListingId]) groups[p.ebayListingId] = [];
    groups[p.ebayListingId].push(p);
  }
  const listingIds = Object.keys(groups);
  const total = listingIds.length;

  res.json({ started: true, total });

  // Process in background — concurrency 3
  const sem = { running: 0, queue: [] };
  async function withLimit(fn) {
    if (sem.running >= 3) await new Promise(r => sem.queue.push(r));
    sem.running++;
    try { return await fn(); } finally {
      sem.running--;
      if (sem.queue.length) sem.queue.shift()();
    }
  }

  let done = 0;
  await Promise.all(listingIds.map(listingId => withLimit(async () => {
    const variants = groups[listingId];
    const primary = variants.find(v => v.status === 'active' && v.specs && Object.keys(v.specs).length) || variants[0];

    try {
      const token = await getAccessToken();
      const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

      // 1. Generate SEO title
      const titleRes = await axios.post(`${BASE}/api/ebay/seo-title`, { title: primary.title, specs: primary.specs });
      const safeTitle = sanitizeTitle(titleRes.data.title || primary.title);

      // 2. Build + enrich item specifics
      const aspects = buildAspects(primary.specs || {});
      if (primary.upc) aspects['UPC'] = [primary.upc];
      if (!aspects['Brand']) aspects['Brand'] = [(primary.specs?.brand_name) || 'Unbranded'];
      const catId = await lookupCategory(safeTitle, primary.upc);
      if (catId) {
        await injectTitleAspects(catId, aspects, safeTitle);
        await enrichAspectsWithAI(catId, aspects, safeTitle, primary.specs, primary.bullets);
      }
      // Remove variation-dimension aspects — eBay handles these at variation level
      ['Color', 'Size', 'Style'].forEach(k => delete aspects[k]);

      // 3. Generate description
      const imageUrls = primary.images?.length ? primary.images : (primary.image ? [primary.image] : []);
      const descRes = await axios.post(`${BASE}/api/ebay/generate-description`, {
        title: safeTitle, specs: primary.specs, imageUrls,
        bullets: primary.bullets || [], upc: primary.upc, variant: primary.variant,
      });
      const html = descRes.data.html;

      // 4. Push to eBay via ReviseFixedPriceItem
      const specificsXml = Object.entries(aspects)
        .map(([name, vals]) => `<NameValueList><Name>${escXml(name)}</Name>${vals.map(v => `<Value>${escXml(v)}</Value>`).join('')}</NameValueList>`)
        .join('');

      const body = `<?xml version="1.0" encoding="utf-8"?><ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        ${creds}
        <Item>
          <ItemID>${escXml(listingId)}</ItemID>
          <Title>${escXml(safeTitle)}</Title>
          <Description><![CDATA[${html}]]></Description>
          <ItemSpecifics>${specificsXml}</ItemSpecifics>
        </Item>
      </ReviseFixedPriceItemRequest>`;

      const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll', body,
        { headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-IAF-TOKEN': token, 'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem', 'Content-Type': 'text/xml' } }
      );
      const ok = !/<Ack>Failure<\/Ack>/.test(xml);
      done++;
      if (_io) _io.emit('ebay:optimize:progress', { done, total, listingId, ok, title: safeTitle });
      console.log(`batch-optimize [${done}/${total}] ${listingId} ${ok ? '✓' : '✗'}`);
    } catch (e) {
      done++;
      if (_io) _io.emit('ebay:optimize:progress', { done, total, listingId, ok: false, error: e.message });
      console.error(`batch-optimize [${done}/${total}] ${listingId} error:`, e.message);
    }
  })));

  if (_io) _io.emit('ebay:optimize:done', { total, done });
});

module.exports = router;
module.exports.setIo = setIo;
