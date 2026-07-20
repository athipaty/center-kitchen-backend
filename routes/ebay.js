const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const EbayToken = require('../models/shared/EbayToken');

const Product = require('../models/tracker/Product');
const { bestVariantMatch, calcEbayPrice } = require('../jobs/ebayPriceSync');
const { b2Enabled, uploadToB2, listB2Files, copyB2File, deleteB2Prefix } = require('../utils/b2Utils');

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

// Upgrade Amazon CDN image URL to best available JPEG.
// • m.media-amazon.com  → strip size qualifiers to get original full-res
// • images-na.ssl-images-amazon.com (Keepa CDN) → append ._SL1500_.jpg to
//   force a 1500px JPEG render (bare Keepa URLs sometimes return GIF placeholders)
function upgradeAmazonImageUrl(url) {
  if (!url) return url;
  if (url.includes('m.media-amazon.com/images/I/'))
    return url.replace(/\._[A-Z0-9_]+_(?=\.jpg)/i, '');
  if (url.includes('images-na.ssl-images-amazon.com/images/I/'))
    return url.replace(/\.(jpg|jpeg|png|gif)$/i, '._SL1500_.jpg');
  return url;
}

// ── Upload Amazon images to B2 permanently ──────────────────────────
router.post('/upload-images', async (req, res) => {
  const { imageUrls, slug } = req.body;
  if (!imageUrls?.length || !slug) return res.status(400).json({ error: 'imageUrls and slug required' });

  const folder = `ebay-listings/${slug}`;

  if (b2Enabled()) {
    // ── B2 path ────────────────────────────────────────────────────
    let existingUrls = [];
    try {
      existingUrls = await listB2Files(folder + '/');
      const hasGif = existingUrls.some(u => u.endsWith('.gif'));
      if (existingUrls.length >= imageUrls.length && !hasGif) {
        console.log(`upload-images: B2 folder ${folder} already has ${existingUrls.length} images — skipping`);
        return res.json({ cloudinaryUrls: existingUrls, cached: true });
      }
      if (hasGif) existingUrls = [];
    } catch (e) {
      console.log('upload-images: B2 folder check failed, uploading fresh:', e.message);
    }

    const startIndex = existingUrls.length;
    const b2Urls = [...existingUrls];

    for (let i = startIndex; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      const fileKey = `${folder}/${slug}-${String(i + 1).padStart(2, '0')}.jpg`;
      try {
        // If source is already a B2 tracker-images file, server-side copy — no download cost
        const isB2TrackerUrl = url.includes('backblazeb2.com') && url.includes('/tracker-images/');
        if (isB2TrackerUrl) {
          const srcKey = url.replace(/^https?:\/\/[^/]+\/file\/[^/]+\//, '');
          const newUrl = await copyB2File(srcKey, fileKey);
          console.log(`upload-images: B2 copied ${srcKey} → ${fileKey}`);
          b2Urls.push(newUrl);
          continue;
        }

        // Standard path: download and upload to B2
        const fullResUrl = upgradeAmazonImageUrl(url);
        let imgBuffer;
        try {
          ({ data: imgBuffer } = await axios.get(fullResUrl, {
            responseType: 'arraybuffer', timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
          }));
        } catch {
          ({ data: imgBuffer } = await axios.get(url, {
            responseType: 'arraybuffer', timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
          }));
        }
        const b2Url = await uploadToB2(Buffer.from(imgBuffer), fileKey, 'image/jpeg');
        b2Urls.push(b2Url);
      } catch (e) {
        console.error(`upload-images: B2 failed for ${url}:`, e.message);
      }
    }

    if (!b2Urls.length) return res.status(500).json({ error: 'All B2 image uploads failed' });

    deleteB2Prefix(`tracker-images/${slug}/`).catch(() => {});
    return res.json({ cloudinaryUrls: b2Urls });
  }

  res.status(500).json({ error: 'B2 image storage is not configured (B2_IMAGES_ENABLED)' });
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

// Trading API responses can carry multiple <Errors> blocks — e.g. a routine account-level
// Warning (funds on hold) alongside the real Error that actually failed the call. Picking
// the first LongMessage in document order surfaces whichever one happens to come first,
// which is often the irrelevant Warning. Prefer an Error-severity block if one exists.
function extractTradingErrorMessage(xml, fallback = 'eBay error') {
  const blocks = [...xml.matchAll(/<Errors>[\s\S]*?<\/Errors>/g)].map(m => m[0]);
  const pick = block => block?.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1]
    || block?.match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/)?.[1];
  const errorBlock = blocks.find(b => /<SeverityCode>Error<\/SeverityCode>/.test(b));
  return pick(errorBlock) || pick(blocks[0]) || fallback;
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
    'https://api.ebay.com/oauth/api_scope/sell.marketing',
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
let EbayAspectsCache;
try { EbayAspectsCache = require('../models/tracker/EbayAspectsCache'); } catch {}
const ASPECTS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days — category aspects rarely change

async function getValidAspectValues(catId) {
  if (!catId) return {};
  // Check MongoDB cache first — avoids one eBay OAuth + Taxonomy API call per listing
  if (EbayAspectsCache) {
    try {
      const cached = await EbayAspectsCache.findById(String(catId)).lean();
      if (cached && new Date(cached.expiresAt) > new Date()) {
        return cached.aspects;
      }
    } catch {}
  }
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
    // Persist to MongoDB for 7 days
    if (EbayAspectsCache) {
      EbayAspectsCache.findByIdAndUpdate(
        String(catId),
        { aspects: result, expiresAt: new Date(Date.now() + ASPECTS_CACHE_TTL) },
        { upsert: true }
      ).catch(() => {});
    }
    console.log(`getValidAspectValues: fetched ${Object.keys(result).length} aspects for cat ${catId} — cached 7 days`);
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
async function enrichAspectsWithAI(catId, aspects, title, specs, bullets = [], variantLabels = []) {
  const catAspects = await getValidAspectValues(catId);
  if (!Object.keys(catAspects).length) return;

  // MPN is excluded from AI-fill entirely, not just guarded after the fact — there's no real
  // signal to infer a manufacturer part number from title/specs/bullets, so asking the model to
  // "provide a value" for it just invites a plausible-looking hallucination (confirmed live:
  // "DNUZEWR" for a trimmer line with no MPN, rejected by eBay error 21919326). MPN only ever
  // comes from buildAspects' own sanitized scrape-derived value, or is left blank.
  const missing = Object.entries(catAspects)
    .filter(([name]) => !aspects[name] && name !== 'Brand' && name !== 'MPN')
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
  const variantText = variantLabels.length ? `Variants: ${variantLabels.join(', ')}` : '';

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `Fill in eBay item specifics for this product.

Title: ${title}
${specText ? `\nSpecs:\n${specText}` : ''}
${bulletText ? `\nBullets:\n${bulletText}` : ''}
${variantText ? `\n${variantText}` : ''}

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
      const val = String(value).slice(0, 65);
      // Belt-and-suspenders even though MPN is no longer requested above — same three guards as
      // buildAspects, in case the model returns it anyway despite not being asked.
      if (name === 'MPN' && /^\d{8,14}$/.test(val.trim())) continue;
      if (name === 'MPN' && /^[A-Z0-9]{6,12}$/.test(val.trim())) continue;
      if (name === 'MPN' && MPN_PLACEHOLDERS.has(val.trim().toLowerCase())) continue;
      const info = catAspects[name];
      if (info?.values?.length) {
        const match = info.values.find(v => v.toLowerCase() === val.toLowerCase());
        if (match) { aspects[name] = [match]; count++; }
      } else {
        aspects[name] = [val]; count++;
      }
    }
    if (count) console.log(`enrichAspectsWithAI: filled ${count} aspects`);
  } catch (e) {
    console.log('enrichAspectsWithAI failed:', e.message);
  }
}

// Amazon sometimes lists a literal placeholder like "No" instead of omitting the field
// when a product has no model number — eBay rejects these as invalid MPN values.
const MPN_PLACEHOLDERS = new Set(['no', 'n/a', 'na', 'none', 'null', 'unknown', '-', '--', 'not applicable', 'tbd']);

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
    if (!specs[k]) continue;
    const val = String(specs[k]).slice(0, 65);
    // Skip MPN if it looks like a barcode, random internal code, or placeholder — eBay rejects all three
    if (label === 'MPN' && /^\d{8,14}$/.test(val.trim())) continue;       // all-digit barcode
    if (label === 'MPN' && /^[A-Z0-9]{6,12}$/.test(val.trim())) continue; // random all-caps code (e.g. RIDOPXRA)
    if (label === 'MPN' && MPN_PLACEHOLDERS.has(val.trim().toLowerCase())) continue; // e.g. "No", "N/A"
    aspects[label] = [val];
  }
  return aspects;
}

function sanitizeSku(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 50) || 'ITEM';
}

// Extract the <Pictures> block (per-variant photo mapping) from a GetItem response so it
// can be re-included verbatim in ReviseFixedPriceItem requests. ReviseFixedPriceItem replaces
// the entire <Variations> container — omitting <Pictures> makes eBay fall back to its default
// photo-to-variant assignment, scrambling carefully-fixed per-variant photos.
function extractVariationPictures(getItemXml) {
  return getItemXml.match(/<Variations>[\s\S]*?(<Pictures>[\s\S]*?<\/Pictures>)[\s\S]*?<\/Variations>/)?.[1] || '';
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
        handlingTime: { unit: 'DAY', value: Number(shipping.handlingDays) || 2 },
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
      shipping = { free: true, carrier: 'USPSFirstClass', handlingDays: 2 },
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
      shipping = { free: true, carrier: 'USPSFirstClass', handlingDays: 2 },
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
    // Convert 4-byte emoji to HTML numeric entities so eBay renders them correctly
    const emoji = s => String(s||'').replace(/[\u{10000}-\u{10FFFF}]/gu, c => `&#${c.codePointAt(0)};`);

    // ── Data richness assessment ──────────────────────────────────────
    // Pull out trust-signal fields separately — BSR and monthly sold belong in the hero/badges,
    // not buried as a plain spec row. Description text is too long for a table cell.
    const EXCLUDE_FROM_TABLE = new Set(['asin','customer_reviews','unspsc_code','description','estimated_monthly_sold','best_sellers_rank','customer_rating','review_count']);
    const cleanSpecs = Object.entries(specs)
      .filter(([k, v]) => v && !EXCLUDE_FROM_TABLE.has(k) && String(v).trim().length > 0)
      .map(([k, v]) => ({ key: k, label: k.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()), value: String(v).trim() }));

    const cleanBullets = bullets
      .map(b => String(b).replace(/[^\x20-\x7E]/g,' ').replace(/<[^>]+>/g,'').trim())
      .filter(b => b.length > 20).slice(0, 8);

    const imgCount   = imageUrls.length;
    const photoRowTarget = Math.min(6, Math.max(5, Math.floor(imgCount / 2)));
    const specCount  = cleanSpecs.length;
    const hasBullets = cleanBullets.length > 0;

    // ── Build Claude prompt with ALL available data ──────────────────
    const specSection = cleanSpecs.length
      ? `\nProduct Specifications (ALL of these must appear in the spec table):\n${cleanSpecs.map(s=>`• ${s.label}: ${s.value}`).join('\n')}`
      : '';
    const bulletSection = hasBullets
      ? `\nProduct Features (USE these as the basis for photo rows and feature cards):\n${cleanBullets.map((b,i)=>`${i+1}. ${b}`).join('\n')}`
      : '';
    const trustSection = [
      specs.description ? `Product description: ${String(specs.description).slice(0, 400)}` : '',
    ].filter(Boolean).join('\n');
    const extraSection = [
      upc ? `UPC/Barcode: ${upc}` : '',
      variant ? `Variant: ${variant}` : '',
      trustSection,
    ].filter(Boolean).join('\n');

    const prompt = `You are an expert eBay copywriter creating a premium, conversion-focused listing description. Use EVERY piece of product data provided — buyers need specifics to make purchase decisions.

Product title: ${title}
Images available: ${imgCount}${extraSection ? `\n${extraSection}` : ''}${specSection}${bulletSection}

Generate a JSON object (raw JSON only, no markdown fences):
{
  "tagline": "Punchy benefit-driven tagline (max 12 words)",
  "heroSub": "2 sentences covering the top 2 customer benefits using specific product details (max 35 words)",
  "trustItems": ["badge1","badge2","badge3","badge4","badge5","badge6"],
  "features": [
    {"icon":"emoji","title":"Feature name","desc":"3 sentences with specific technical details, materials, measurements, or use-case benefits drawn from the product data"},
    {"icon":"emoji","title":"Feature name","desc":"3 sentences with specific technical details, materials, measurements, or use-case benefits drawn from the product data"},
    {"icon":"emoji","title":"Feature name","desc":"3 sentences with specific technical details, materials, measurements, or use-case benefits drawn from the product data"},
    {"icon":"emoji","title":"Feature name","desc":"3 sentences with specific technical details, materials, measurements, or use-case benefits drawn from the product data"},
    {"icon":"emoji","title":"Feature name","desc":"3 sentences with specific technical details, materials, measurements, or use-case benefits drawn from the product data"}
  ],
  "photoRows": [
    {"label":"Feature 01","heading":"Benefit-focused heading","body":"3 sentences from product data — be specific, use numbers/materials/dimensions","bullets":["specific measurable point","specific point with data","specific point with data","specific point with data","specific point with data"]},
    ... generate exactly ${photoRowTarget} photo rows total, each covering a distinct feature or benefit
  ],
  "ctaHeading": "Compelling action-oriented headline",
  "ctaSub": "2 sentences that reinforce value and reassure the buyer",
  "seoText": "4-5 natural readable sentences describing the product for buyers — include product type, key materials, dimensions/quantities, primary use cases, who it's for, and standout features as flowing prose. Write for a human reader.",
  "theme": "blue|green|orange|navy|teal|red|purple"
}

CRITICAL rules:
- Generate EXACTLY ${photoRowTarget} photoRows — each covering a DIFFERENT feature or use case
- Each photoRow must have EXACTLY 5 bullets — all specific, no filler
- If Amazon bullets/features are provided, base content DIRECTLY on those — extract exact specs, materials, dimensions
- Use SPECIFIC data everywhere: numbers, percentages, materials, certifications, dimensions — never vague adjectives alone
- seoText: natural flowing prose, 4-5 sentences, no lists, no repetition
- theme: blue=water/pool/cooling/tech, green=natural/eco/bamboo/organic, orange=energy/sport/outdoor, navy=car/travel/professional, teal=bathroom/home/wellness, red=pest/safety/alert, purple=garden/luxury/premium
- trustItems: use real product attributes (warranty, certification, material quality, shipping speed, return policy) — no generic filler
- FORBIDDEN: competitor names, fake reviews, false urgency, external links, HTML tags inside JSON string values`;

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
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
      return `<div class="pr${even ? ' pr-rev' : ''}">
<div class="pc">${imgUrl ? `<img src="${imgUrl}" alt="${esc(row.heading||'')}">` : ''}</div>
<div class="tc">
<h3>${esc(row.heading||'')}</h3><p>${esc(row.body||'')}</p>
${(row.bullets||[]).length ? `<ul>${row.bullets.map(b=>`<li>${esc(b)}</li>`).join('')}</ul>` : ''}
</div></div>`;
    }).join('');

    // ── Complete spec table — ALL specs + UPC + variant + condition ───
    const allSpecRows = [
      ...cleanSpecs.map(s => `<tr><td class="sk">${esc(s.label)}</td><td>${esc(s.value)}</td></tr>`),
      upc     ? `<tr><td class="sk">UPC / Barcode</td><td>${esc(upc)}</td></tr>` : '',
      variant ? `<tr><td class="sk">Variant</td><td>${esc(variant)}</td></tr>` : '',
      `<tr><td class="sk">Condition</td><td>New</td></tr>`,
    ].filter(Boolean).join('');

    // specTableHtml replaced by specTableHtml2col (2-column desktop layout, built below)

    // ── HTML ──────────────────────────────────────────────────────────
    // ── Spec table: 2-column layout on desktop ────────────────────────
    const specPairs = [];
    const allSpecRowArr = [
      ...cleanSpecs.map(s => ({ k: s.label, v: s.value })),
      ...(upc     ? [{ k: 'UPC / Barcode', v: upc }]     : []),
      ...(variant ? [{ k: 'Variant',       v: variant }]  : []),
      { k: 'Condition', v: 'New' },
    ];
    for (let i = 0; i < allSpecRowArr.length; i += 2) {
      specPairs.push([allSpecRowArr[i], allSpecRowArr[i + 1] || null]);
    }
    const specTableHtml2col = specPairs.length ? `
<div class="sh"><h2>Full Product Specifications</h2><div class="div"></div></div>
<div class="ss"><table class="st">
<tr><th colspan="4">Technical Details</th></tr>
${specPairs.map(([a, b]) => `<tr>
  <td class="sk">${esc(a.k)}</td><td class="sv">${esc(a.v)}</td>
  ${b ? `<td class="sk">${esc(b.k)}</td><td class="sv">${esc(b.v)}</td>` : '<td colspan="2"></td>'}
</tr>`).join('')}
</table></div>` : '';

    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#222;background:#fff;max-width:900px;margin:0 auto}

/* ── Hero: split layout on desktop ── */
.hero{background:${t.dark};display:flex;align-items:stretch;min-height:340px}
.hero-img{flex:0 0 48%;background:${t.dark}}
.hero-img img{width:100%;height:100%;max-height:420px;object-fit:contain;display:block}
.hero-body{flex:1 1 0;display:flex;flex-direction:column;justify-content:center;padding:36px 32px}
.hero-tag{display:inline-block;background:${t.accent};color:#fff;font-family:Georgia,serif;font-size:10px;letter-spacing:2.5px;text-transform:uppercase;padding:5px 14px;border-radius:20px;margin-bottom:14px;align-self:flex-start}
.hero-title{font-family:Georgia,serif;font-size:24px;font-weight:bold;color:#fff;line-height:1.35;margin-bottom:12px}
.hero-sub{font-size:14px;color:rgba(255,255,255,0.78);line-height:1.7}
.hero-badges{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
.hb{background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.25);color:#fff;font-size:11px;font-weight:bold;padding:6px 12px;border-radius:16px}

/* ── Trust bar ── */
.trust-bar{background:${t.primary};display:flex;flex-wrap:wrap;justify-content:center}
.ti{display:flex;align-items:center;gap:6px;color:#fff;font-size:12px;font-weight:bold;padding:11px 18px;border-right:1px solid rgba(255,255,255,0.2);white-space:nowrap}
.ti:last-child{border-right:none}

/* ── Section headings ── */
.sh{text-align:center;padding:36px 20px 12px}
.sh h2{font-family:Georgia,serif;font-size:22px;color:${t.dk};margin-bottom:6px}
.div{width:48px;height:3px;background:${t.accent};margin:8px auto 0;border-radius:2px}

/* ── Feature grid: auto-fill cols, min 240px ── */
.fg{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;padding:18px 20px 34px}
.fc{background:${t.light};border:1px solid ${t.border};border-radius:12px;padding:22px 18px;text-align:center}
.fi{font-size:34px;margin-bottom:10px;display:block}
.fc h3{font-family:Georgia,serif;font-size:15px;color:${t.dk};margin-bottom:7px}
.fc p{font-size:13px;color:#555;line-height:1.55}

/* ── Photo rows: 50/50 split ── */
.pr{display:flex;align-items:stretch;border-bottom:1px solid ${t.border};overflow:hidden}
.pr-rev{flex-direction:row-reverse}
.pc{flex:0 0 50%}
.pc img{width:100%;height:320px;object-fit:contain;background:${t.light};display:block}
.tc{flex:1 1 0;padding:32px 28px;display:flex;flex-direction:column;justify-content:center}
.lbl{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${t.accent};font-weight:bold;margin-bottom:8px}
.tc h3{font-family:Georgia,serif;font-size:19px;color:${t.dk};margin-bottom:10px;line-height:1.3}
.tc p{font-size:14px;color:#555;line-height:1.65;margin-bottom:10px}
.tc ul{padding-left:18px;margin-top:4px}
.tc ul li{font-size:13px;color:#555;line-height:1.65;margin-bottom:6px}

/* ── Spec table: 2-col layout ── */
.ss{padding:0 16px 32px}
.st{width:100%;border-collapse:collapse;font-size:14px}
.st th{background:${t.dk};color:#fff;font-family:Georgia,serif;padding:11px 14px;text-align:left;font-size:15px}
.sk{color:${t.dk};width:18%;font-weight:bold;font-size:13px;padding:9px 12px;border-bottom:1px solid ${t.border};background:${t.light};vertical-align:top}
.sv{padding:9px 14px;border-bottom:1px solid ${t.border};vertical-align:top;word-break:break-word;width:32%}
.st tr:nth-child(even) .sv{background:#fafafa}

/* ── CTA ── */
.cta{background:linear-gradient(135deg,${t.dk} 0%,${t.primary} 55%,${t.accent} 100%);text-align:center;padding:40px 24px}
.cta h2{font-family:Georgia,serif;font-size:24px;color:#fff;margin-bottom:10px}
.cta p{font-size:15px;color:rgba(255,255,255,0.85);margin-bottom:20px;line-height:1.6;max-width:560px;margin-left:auto;margin-right:auto}
.cb{display:grid;grid-template-columns:repeat(2,auto);gap:10px;justify-content:center;margin-top:4px}
.cbb{background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.35);color:#fff;font-size:12px;font-weight:bold;padding:10px 20px;border-radius:24px;text-align:left}

/* ── Footer ── */
.ft{background:#f4f4f4;border-top:2px solid ${t.border};padding:14px;text-align:center;font-size:12px;color:#888;line-height:1.65}
.kw{padding:14px 20px 4px;font-size:12px;color:#aaa;line-height:1.7;text-align:center;max-width:820px;margin:0 auto}

/* ── Mobile overrides ── */
@media(max-width:580px){
  body{font-size:14px}
  .hero{flex-direction:column;min-height:0}
  .hero-img{flex:0 0 auto}
  .hero-img img{max-height:280px;width:100%}
  .hero-body{padding:20px 16px 24px}
  body{font-size:17px}
  .hero-title{font-size:20px}
  .hero-sub{font-size:15px}
  .hero-badges{display:none}
  .trust-bar{flex-direction:column;align-items:stretch}
  .ti{border-right:none;border-bottom:1px solid rgba(255,255,255,0.15);justify-content:center;padding:10px 14px}
  .ti:last-child{border-bottom:none}
  .fg{grid-template-columns:1fr;gap:10px;padding:14px 12px 22px}
  .pr{flex-direction:column !important}
  .pc{flex:0 0 auto;width:100%}
  .pc img{height:240px}
  .tc{padding:16px 14px}
  .tc h3{font-size:18px}
  .tc p{font-size:16px}
  .tc ul li{font-size:16px}
  .st{font-size:15px}
  .sk,.sv{padding:8px 10px;width:auto}
  .st tr{display:grid;grid-template-columns:1fr 1fr}
  .sh h2{font-size:20px}
  .cta{padding:26px 14px}
  .cta h2{font-size:21px}
  .cb{grid-template-columns:1fr;justify-items:center}
  .cbb{width:100%;max-width:240px;text-align:center}
}
</style></head><body>
<div class="hero">
  <div class="hero-img">${imageUrls[0]?`<img src="${imageUrls[0]}" alt="${esc(title)}">`:''}</div>
  <div class="hero-body">
    <span class="hero-tag">${esc(content.tagline||'')}</span>
    <h1 class="hero-title">${esc(title)}</h1>
    <p class="hero-sub">${esc(content.heroSub||'')}</p>
    <div class="hero-badges">${tr.slice(0,3).map(x=>`<span class="hb">&#10003; ${esc(x)}</span>`).join('')}</div>
  </div>
</div>
<div class="trust-bar">${tr.map(x=>`<div class="ti">&#9989; ${esc(x)}</div>`).join('')}</div>
<div class="sh"><h2>Why Choose This Product?</h2><div class="div"></div></div>
<div class="fg">${f.map(x=>`<div class="fc"><span class="fi">${emoji(x.icon)||'&#10003;'}</span><h3>${esc(x.title)}</h3><p>${esc(x.desc)}</p></div>`).join('')}</div>
${photoRowsHtml}
${specTableHtml2col}
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

    // Run GTIN and keyword search together and merge — GTIN search only matches eBay's own
    // product-catalog linkage, not "every listing tagged with this GTIN": plenty of sellers
    // (especially smaller ones) never get catalog-matched, so GTIN alone silently under-returns.
    // Confirmed live on a real case: GTIN search returned 3 listings (cheapest $17.99) while a
    // title search on the same product returned 20 (cheapest $11.32), including listings that
    // report that exact GTIN on their own item page but never surfaced in the GTIN search index.
    async function searchListings(buyingOption) {
      const searches = [];
      if (upc) {
        searches.push(
          axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
            params: { gtin: upc, filter: `conditions:{NEW},buyingOptions:{${buyingOption}}`, sort: 'price', limit: 20 },
            headers: h, timeout: 8000,
          }).then(r => r.data.itemSummaries || []).catch(() => [])
        );
      }
      if (title) {
        const q = title.split(' ').slice(0, 6).join(' ');
        searches.push(
          axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
            params: { q, filter: `conditions:{NEW},buyingOptions:{${buyingOption}}`, sort: 'price', limit: 20 },
            headers: h, timeout: 8000,
          }).then(r => r.data.itemSummaries || []).catch(() => [])
        );
      }
      const merged = (await Promise.all(searches)).flat();
      const seen = new Set();
      return merged.filter(item => {
        if (seen.has(item.itemId)) return false;
        seen.add(item.itemId);
        return true;
      });
    }

    const items = await searchListings('FIXED_PRICE');

    const withPrice = items
      .map(item => ({ item, price: parseFloat(item.price?.value || 0) }))
      .filter(({ price }) => price >= 3)  // exclude obvious noise (broken listings, unrelated items)
      .sort((a, b) => a.price - b.price);

    if (!withPrice.length) {
      const empty = { count: 0, lowest: null, median: null, avg: null, items: [] };
      setCache(cacheKey, empty);
      return res.json(empty);
    }

    const prices = withPrice.map(w => w.price);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 !== 0
      ? prices[mid]
      : Math.round(((prices[mid - 1] + prices[mid]) / 2) * 100) / 100;

    const result = {
      count: prices.length,
      lowest: prices[0],
      median,
      avg: Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100,
      // Cheapest 5 listings, for a side-by-side comparison against your own planned price
      items: withPrice.slice(0, 5).map(({ item, price }) => ({
        title: item.title,
        price,
        url: item.itemWebUrl || null,
        image: item.image?.imageUrl || null,
        condition: item.condition || null,
        seller: item.seller?.username || null,
      })),
    };
    setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: ebayError(err) });
  }
});

// eBay retired the legacy Finding API (findCompletedItems) in Feb 2025 — this now uses the
// Buy Marketplace Insights API instead. That API is limited-release: it 403s with a scope
// error unless eBay has explicitly approved this app for buy.marketplace.insights.
router.get('/sold', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  const cacheKey = `sold:${q}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const { data: appToken } = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope/buy.marketplace.insights' }),
      { headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
    );

    const { data } = await axios.get('https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search', {
      params: { q, limit: 20 },
      headers: { Authorization: `Bearer ${appToken.access_token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
      timeout: 8000,
    });

    const withPrice = (data.itemSales || [])
      .map(item => ({ item, price: parseFloat(item.lastSoldPrice?.value || 0) }))
      .filter(({ price }) => price > 0)
      .sort((a, b) => new Date(b.item.lastSoldDate || 0) - new Date(a.item.lastSoldDate || 0)); // most recent first

    if (!withPrice.length) {
      const empty = { count: 0, avg: null, min: null, max: null, items: [] };
      setCache(cacheKey, empty);
      return res.json(empty);
    }

    const prices = withPrice.map(w => w.price);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const result = {
      count: prices.length,
      avg: Math.round(avg * 100) / 100,
      min: Math.min(...prices),
      max: Math.max(...prices),
      // 5 most recently sold, for a side-by-side comparison against your own planned price
      items: withPrice.slice(0, 5).map(({ item, price }) => ({
        title: item.title,
        price,
        url: item.itemWebUrl || item.itemHref || null,
        image: item.image?.imageUrl || null,
        condition: item.condition || null,
        soldDate: item.lastSoldDate || null,
      })),
    };
    setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(err.response?.status === 403 ? 403 : 500).json({ error: ebayError(err) });
  }
});

// ── Debug: raw GetMyeBaySelling section lengths + samples ──────────
// GET this seller's payment policies, with immediatePay flagged — used to diagnose eBay error
// 21917141 ("To require immediate payment, you must specify a Buy It Now price"). Read-only,
// no side effects.
router.get('/payment-policies/debug', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { data } = await axios.get('https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_US', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const policies = (data.paymentPolicies || []).map(p => ({
      name: p.name, paymentPolicyId: p.paymentPolicyId, immediatePay: p.immediatePay,
    }));
    res.json({ policies });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

router.get('/selling-limits/debug', async (req, res) => {
  try {
    const token = await getAccessToken();
    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        ${creds}
        <ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></ActiveList>
        <SoldList><Include>true</Include><DurationInDays>60</DurationInDays><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></SoldList>
        <UnsoldList><Include>true</Include><DurationInDays>60</DurationInDays><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></UnsoldList>
        <ScheduledList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></ScheduledList>
      </GetMyeBaySellingRequest>`;
    const { data: xmlResp } = await axios.post('https://api.ebay.com/ws/api.dll', xml, {
      headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' },
    });
    const activeSection = xmlResp.match(/<ActiveList>([\s\S]*?)<\/ActiveList>/)?.[1] || '';
    const soldSection   = xmlResp.match(/<SoldList>([\s\S]*?)<\/SoldList>/)?.[1] || '';
    const unsoldSection = xmlResp.match(/<UnsoldList>([\s\S]*?)<\/UnsoldList>/)?.[1] || '';
    const scheduledSection = xmlResp.match(/<ScheduledList>([\s\S]*?)<\/ScheduledList>/)?.[1] || '';
    const scheduledItems = [...scheduledSection.matchAll(/<Item>([\s\S]*?)<\/Item>/g)];
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
    const scheduledBreakdown = scheduledItems.map(([,b]) => {
      const itemId = b.match(/<ItemID>(\d+)<\/ItemID>/)?.[1] || '?';
      const vars = [...b.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)];
      const qty = parseInt(b.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] || '0');
      return { itemId, hasVariations: vars.length > 0, varCount: vars.length, qty };
    });
    res.json({
      activeItemCount: activeItems.length,
      soldTxCount: soldTxs.length,
      unsoldItemCount: unsoldItems.length,
      scheduledItemCount: scheduledItems.length,
      scheduledBreakdown,
      activeBreakdown,
      unsoldBreakdown,
      soldItemIds: [...new Set(soldTxs.map(([,b]) => b.match(/<ItemID>(\d+)<\/ItemID>/)?.[1]).filter(Boolean))],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// eBay doesn't expose the selling-limit cycle's reset date via any API (confirmed: getPrivileges
// only returns the static thresholds). We calibrate the day-of-month it resets on against the
// real "used" number shown in Seller Hub (via /selling-limits/calibrate) and persist it on
// EbayToken.limitCycleStartDay, then derive each cycle's start from that day going forward.
function cycleStartFor(day, ref = new Date()) {
  let start = new Date(ref.getFullYear(), ref.getMonth(), day);
  if (start > ref) start = new Date(ref.getFullYear(), ref.getMonth() - 1, day);
  return start;
}

// Counts used quantity/units and revenue from a GetMyeBaySelling response.
// Matches eBay's "listed and sold" cycle count: it's a QUANTITY count (Quantity + QuantitySold
// per SKU/variation, or per top-level item when there are no variations) — NOT a count of
// listings or distinct variation slots. A listing with 5 variations at qty 2 each uses 10 slots,
// not 5 or 1. Ended listings (sold or unsold) whose StartTime falls within the current billing
// cycle also count. De-duplicates by ItemID so a listing appearing in both ActiveList and
// SoldList (e.g. partially sold multi-variation) is only counted once.
function countUsedItems(xmlResp, monthStart) {
  let totalQtyListed = 0;
  let soldRevenueUsd = 0;
  const countedIds = new Set();

  function countSection(sectionXml, requireAfter) {
    for (const [, block] of [...sectionXml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)]) {
      const itemId = block.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];
      if (!itemId || countedIds.has(itemId)) continue;

      // For ended sections filter by cycle start — only count items listed this cycle.
      if (requireAfter) {
        const startTime = block.match(/<StartTime>([^<]+)<\/StartTime>/)?.[1];
        if (startTime && new Date(startTime) < requireAfter) continue;
      }

      countedIds.add(itemId);
      const varBlocks = [...block.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)];

      if (varBlocks.length) {
        for (const [, vb] of varBlocks) {
          const qty = parseInt(vb.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] || '0');
          const sold = parseInt(vb.match(/<QuantitySold>(\d+)<\/QuantitySold>/)?.[1] || '0');
          totalQtyListed += qty + sold;
          if (sold) {
            const price = parseFloat(vb.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || '0');
            soldRevenueUsd += price * sold;
          }
        }
      } else {
        const qty = parseInt(block.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] || '0');
        const sold = parseInt(block.match(/<QuantitySold>(\d+)<\/QuantitySold>/)?.[1] || '0');
        totalQtyListed += qty + sold;
        if (sold) {
          const price = parseFloat(block.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || '0');
          soldRevenueUsd += price * sold;
        }
      }
    }
  }

  const activeSection  = xmlResp.match(/<ActiveList>([\s\S]*?)<\/ActiveList>/)?.[1]  || '';
  const soldSection    = xmlResp.match(/<SoldList>([\s\S]*?)<\/SoldList>/)?.[1]       || '';
  const unsoldSection  = xmlResp.match(/<UnsoldList>([\s\S]*?)<\/UnsoldList>/)?.[1]  || '';

  countSection(activeSection, null);         // all active — no date filter needed
  countSection(soldSection,   monthStart);   // ended+sold: only this cycle
  countSection(unsoldSection, monthStart);   // ended+unsold: only this cycle

  return { usedItems: totalQtyListed, soldRevenueUsd };
}

async function fetchMyeBaySellingXml(token) {
  const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
  const xml = `<?xml version="1.0" encoding="utf-8"?>
    <GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
      ${creds}
      <ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></ActiveList>
      <SoldList><Include>true</Include><DurationInDays>60</DurationInDays><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></SoldList>
      <UnsoldList><Include>true</Include><DurationInDays>60</DurationInDays><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></UnsoldList>
    </GetMyeBaySellingRequest>`;
  const { data } = await axios.post('https://api.ebay.com/ws/api.dll', xml, {
    headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' },
  });
  return data;
}

// Calibrate the cycle-reset day-of-month against the real "used" count from Seller Hub.
// Tries every day-of-month, finds the contiguous range of days whose resulting count matches,
// and persists the smallest (earliest) day in that range — the tightest boundary consistent
// with the data, since later items pushing the count higher would shrink the matching range.
router.post('/selling-limits/calibrate', async (req, res) => {
  try {
    const actualUsed = parseInt(req.body?.actualUsed);
    if (!Number.isFinite(actualUsed)) return res.status(400).json({ error: 'actualUsed (number) is required' });

    const token = await getAccessToken();
    const xmlResp = await fetchMyeBaySellingXml(token);
    const today = new Date();

    const matches = [];
    for (let day = 1; day <= 28; day++) {
      const monthStart = cycleStartFor(day, today);
      const { usedItems } = countUsedItems(xmlResp, monthStart);
      matches.push({ day, monthStart: monthStart.toISOString(), usedItems, isMatch: usedItems === actualUsed });
    }

    const matchingDays = matches.filter(m => m.isMatch).map(m => m.day);
    if (!matchingDays.length) {
      return res.status(404).json({ error: 'no_matching_cycle_day', message: `No day-of-month produces a count of ${actualUsed}`, attempts: matches });
    }

    const calibratedDay = Math.min(...matchingDays);
    await EbayToken.findByIdAndUpdate('ebay', { limitCycleStartDay: calibratedDay }, { upsert: true, new: true });

    res.json({
      ok: true,
      calibratedDay,
      matchingDays,
      cycleStart: cycleStartFor(calibratedDay, today).toISOString(),
      message: `Cycle reset day calibrated to the ${calibratedDay}${['th','st','nd','rd'][(calibratedDay % 10 === 1 || calibratedDay % 10 === 2 || calibratedDay % 10 === 3) && ![11,12,13].includes(calibratedDay) ? calibratedDay % 10 : 0]} of each month.`,
    });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message });
  }
});

// ── Monthly selling limits usage ──────────────────────────────────
let _sellingLimitsCache = null; // { data, expiresAt }
router.get('/selling-limits', async (req, res) => {
  if (_sellingLimitsCache && Date.now() < _sellingLimitsCache.expiresAt) {
    return res.json(_sellingLimitsCache.data);
  }
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

    const xmlResp = await fetchMyeBaySellingXml(token);

    // eBay's selling-limit cycle resets on a fixed day-of-month it doesn't expose via any API.
    // Use the calibrated day if we have one (see /selling-limits/calibrate); default to the 1st.
    const tokenDoc = await EbayToken.findById('ebay');
    const monthStart = cycleStartFor(tokenDoc?.limitCycleStartDay || 1);
    const { usedItems, soldRevenueUsd } = countUsedItems(xmlResp, monthStart);
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

    const payload = {
      items:   { used: usedItems, limit: itemLimit, remaining: Math.max(0, itemLimit - usedItems) },
      revenue: {
        usedUsd: Math.round(usedRevUsd * 100) / 100,
        limitUsd: Math.round(revLimitUsd * 100) / 100,
        remaining: Math.round(Math.max(0, revLimitUsd - usedRevUsd) * 100) / 100,
        rate: sgdToUsd,
        source: revenueSource,
      },
    };
    _sellingLimitsCache = { data: payload, expiresAt: Date.now() + 10 * 60 * 1000 }; // 10 min
    res.json(payload);
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message });
  }
});

// ── All active listings via Trading API (includes manually created) ─
let _allActiveListingsCache = null; // { data, expiresAt }
router.get('/all-active-listings', async (req, res) => {
  if (_allActiveListingsCache && Date.now() < _allActiveListingsCache.expiresAt) {
    return res.json(_allActiveListingsCache.data);
  }
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

    _allActiveListingsCache = { data: items, expiresAt: Date.now() + 5 * 60 * 1000 }; // 5 min
    res.json(items);
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    console.error('all-active-listings error:', err.response?.data || err.message);
    res.json([]); // Fail gracefully — don't break the page
  }
});

// ── Orphan listings: active on eBay but not linked in the tracker ──
async function getOrphanListings() {
  const Product = require('../models/tracker/Product');
  const token = await getAccessToken();

  // Fetch all active eBay listings (paginated, up to 200)
  const allEbayItems = [];
  for (let page = 1; page <= 2; page++) {
    const xml = `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ActiveList><Include>true</Include><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList></GetMyeBaySellingRequest>`;
    const { data: xmlResp } = await axios.post('https://api.ebay.com/ws/api.dll', xml, {
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml',
      },
    });
    if (/<Ack>Failure<\/Ack>/.test(xmlResp)) break;
    const itemRe = /<Item>([\s\S]*?)<\/Item>/g;
    let m;
    while ((m = itemRe.exec(xmlResp)) !== null) {
      const block = m[1];
      const get = tag => { const tm = block.match(new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`)); return tm ? tm[1].trim() : null; };
      const listingId = get('ItemID');
      if (listingId) allEbayItems.push({ listingId, title: get('Title') || listingId });
    }
    if (!/<HasMoreItems>true<\/HasMoreItems>/.test(xmlResp)) break;
  }

  // Get all tracked listing IDs from DB
  const tracked = await Product.distinct('ebayListingId', { ebayListingId: { $exists: true, $ne: null } });
  const trackedSet = new Set(tracked.map(String));

  // Orphans = active on eBay but not linked to any tracker product
  return allEbayItems.filter(item => !trackedSet.has(String(item.listingId)));
}

router.get('/orphan-listings', async (req, res) => {
  try {
    const orphans = await getOrphanListings();
    res.json({ count: orphans.length, orphans });
  } catch (err) {
    if (err.message === 'not_authenticated') return res.status(401).json({ error: 'not_authenticated' });
    console.error('orphan-listings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/orphan-listings', async (req, res) => {
  try {
    // Delegate to the scheduler's shared function — also emits tracker:orphan:cleanup socket event
    await require('../jobs/trackerScheduler').orphanCleanup();
    res.json({ ok: true });
  } catch (err) {
    if (err.message === 'not_authenticated') return res.status(401).json({ error: 'not_authenticated' });
    console.error('end-orphan-listings error:', err.message);
    res.status(500).json({ error: err.message });
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

// ── Revise photos on an existing single listing ─────────────────────
router.post('/listing/:id/revise-photos', async (req, res) => {
  try {
    const token = await getAccessToken();
    const cleanId = String(req.params.id).trim().replace(/\D/g, '');
    const { imageUrls = [] } = req.body;
    if (!cleanId) return res.status(400).json({ error: 'Invalid listing ID' });
    if (!imageUrls.length) return res.status(400).json({ error: 'imageUrls required' });

    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
    const picsXml = [...new Set(imageUrls)].slice(0, 12).map(u => `<PictureURL>${u}</PictureURL>`).join('');
    const body = `<?xml version="1.0" encoding="utf-8"?><ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
      ${creds}
      <Item><ItemID>${cleanId}</ItemID><PictureDetails>${picsXml}</PictureDetails></Item>
    </ReviseFixedPriceItemRequest>`;

    const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll', body, {
      headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-IAF-TOKEN': token, 'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem', 'Content-Type': 'text/xml' },
    });
    if (/<Ack>Failure<\/Ack>/.test(xml)) {
      return res.status(400).json({ error: extractTradingErrorMessage(xml) });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update variation photos on an existing multi-variation listing ──
router.post('/listing/variation-photos', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { listingId, variantDimension, variants } = req.body;
    // variants: [{ label, image, images }]
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

    // Step 1: Read the live listing so we use eBay's exact dimension name and label spellings.
    // This is critical — if the name doesn't match (e.g. "Color" vs "Style") eBay silently
    // ignores the photo update and keeps showing the wrong image for each variant.
    let dimName = variantDimension || 'Color';
    const ebayLabelMap = {}; // lowercase → exact stored label
    let existingVarXml = ''; // preserve existing <Variation> elements alongside Pictures
    const existingPicMap = {}; // lowercase label → { label, pics } from current eBay Photos block
    try {
      const { data: getXml } = await axios.post('https://api.ebay.com/ws/api.dll',
        `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID></GetItemRequest>`,
        { headers: { ...tradingHeaders, 'X-EBAY-API-CALL-NAME': 'GetItem' } }
      );

      const decodeXml = s => (s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

      // Prefer dimension stored in Pictures block (most reliable if photos were set before)
      const picBlock = getXml.match(/<Pictures>([\s\S]*?)<\/Pictures>/)?.[1] || '';
      const dimFromPic = picBlock.match(/<VariationSpecificName>([\s\S]*?)<\/VariationSpecificName>/)?.[1];
      if (dimFromPic) {
        dimName = decodeXml(dimFromPic);
        console.log(`variation-photos: dimension from Pictures="${dimName}" (listing ${cleanId})`);
      } else {
        // Fall back: read from the first Variation's NameValueList
        const firstVarBlock = getXml.match(/<Variation>([\s\S]*?)<\/Variation>/)?.[1] || '';
        const dimFromVar = firstVarBlock.match(/<NameValueList>[\s\S]*?<Name>([\s\S]*?)<\/Name>/)?.[1];
        if (dimFromVar) {
          dimName = decodeXml(dimFromVar);
          console.log(`variation-photos: dimension from Variation="${dimName}" (listing ${cleanId})`);
        }
      }

      // Build lowercase → exact label map so variant labels round-trip correctly
      const varRe2 = /<Variation>([\s\S]*?)<\/Variation>/g;
      let vm2;
      while ((vm2 = varRe2.exec(getXml)) !== null) {
        const nvRe2 = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
        let nv2;
        while ((nv2 = nvRe2.exec(vm2[1])) !== null) {
          const raw = nv2[1].match(/<Value>([\s\S]*?)<\/Value>/)?.[1] || '';
          const decoded = decodeXml(raw);
          if (decoded) ebayLabelMap[decoded.toLowerCase()] = decoded;
        }
      }
      console.log(`variation-photos: ${Object.keys(ebayLabelMap).length} eBay labels mapped`);
      if (!/<Variation>/i.test(getXml)) {
        return res.status(400).json({ error: 'This listing has no variations — Fix Variation Photos only applies to multi-variation listings.' });
      }
      // Preserve all existing <Variation> elements — ReviseFixedPriceItem replaces the entire
      // <Variations> container, so omitting them would delete all variations from the listing.
      const varRe3 = /<Variation>([\s\S]*?)<\/Variation>/g;
      let vm3;
      while ((vm3 = varRe3.exec(getXml)) !== null) {
        const priceM = vm3[1].match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/);
        const qtyM   = vm3[1].match(/<Quantity>(\d+)<\/Quantity>/);
        const specsM = vm3[1].match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/);
        const skuM   = vm3[1].match(/<SKU>([\s\S]*?)<\/SKU>/);
        const price3 = priceM ? priceM[1] : '0.00';
        const qty3   = qtyM   ? qtyM[1]   : '1';
        const specs3 = specsM ? specsM[1]  : '';
        const sku3   = skuM   ? `<SKU>${skuM[1]}</SKU>` : '';
        existingVarXml += `<Variation>${sku3}<StartPrice currencyID="USD">${price3}</StartPrice><Quantity>${qty3}</Quantity><VariationSpecifics>${specs3}</VariationSpecifics></Variation>`;
      }

      // Parse existing VariationSpecificPictureSet blocks so we can preserve photos
      // for variants not included in this request (partial updates must not wipe others).
      const picSetRe = /<VariationSpecificPictureSet>([\s\S]*?)<\/VariationSpecificPictureSet>/g;
      let psm;
      while ((psm = picSetRe.exec(getXml)) !== null) {
        const block = psm[1];
        const val = decodeXml(block.match(/<VariationSpecificValue>([\s\S]*?)<\/VariationSpecificValue>/)?.[1] || '');
        const pics = [...block.matchAll(/<PictureURL>([\s\S]*?)<\/PictureURL>/g)].map(m => decodeXml(m[1]));
        if (val && pics.length) existingPicMap[val.toLowerCase()] = { label: val, pics };
      }
    } catch (e) {
      console.log('variation-photos: GetItem failed, using supplied dimension:', dimName, e.message);
    }

    const withImages = variants.filter(v => v.images?.length || v.image);
    if (!withImages.length) return res.status(400).json({ error: 'No variant images provided' });

    // Build map of incoming images by lowercase label
    const incomingMap = {};
    for (const v of withImages) {
      incomingMap[(v.label || '').toLowerCase()] = v.images?.length ? v.images : (v.image ? [v.image] : []);
    }

    // Merge: use incoming images where provided; fall back to existing eBay photos for the rest.
    // Result includes ALL known variation labels so no variant loses its photos.
    const allLabels = new Set([
      ...Object.keys(ebayLabelMap),
      ...Object.keys(existingPicMap),
      ...withImages.map(v => (v.label || '').toLowerCase()),
    ]);

    const pictureSets = [...allLabels].map(lowerLabel => {
      const exactLabel = ebayLabelMap[lowerLabel] || existingPicMap[lowerLabel]?.label
        || withImages.find(v => v.label?.toLowerCase() === lowerLabel)?.label || lowerLabel;
      const imgs = incomingMap[lowerLabel] || existingPicMap[lowerLabel]?.pics || [];
      if (!imgs.length) return '';
      return `<VariationSpecificPictureSet>
        <VariationSpecificValue>${escXml(exactLabel)}</VariationSpecificValue>
        ${imgs.map(img => `<PictureURL>${escXml(img)}</PictureURL>`).join('')}
      </VariationSpecificPictureSet>`;
    }).filter(Boolean).join('');

    const body = `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
      ${creds}
      <Item>
        <ItemID>${cleanId}</ItemID>
        <Variations>
          ${existingVarXml}
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
      return res.status(400).json({ error: extractTradingErrorMessage(xml) });
    }

    console.log(`variation-photos: updated ${withImages.length} variants on listing ${cleanId} (dimension="${dimName}")`);
    res.json({ ok: true, updated: withImages.length, dimension: dimName });
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
      const msgs = [];
      const errRe = /<Errors>([\s\S]*?)<\/Errors>/g;
      let em;
      while ((em = errRe.exec(xml)) !== null) {
        const sev = em[1].match(/<SeverityCode>([^<]+)<\/SeverityCode>/)?.[1] || '';
        if (sev === 'Warning') continue;
        const msg = em[1].match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1]
          || em[1].match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/)?.[1] || '';
        if (msg) msgs.push(msg);
      }
      return msgs.length ? msgs.join(' | ') : null;
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
            if (val === label) { isMatch = true; break; }
          }
        }

        const thisPrice = isMatch ? priceStr : currentPrice;
        const specificsContent = vBlock.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
        const sku = vBlock.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
        const varVal = vBlock.match(/<Value>([\s\S]*?)<\/Value>/)?.[1] || '';
        const skuXml = `<SKU>${sku || sanitizeSku(`${cleanId}-${varVal}`)}</SKU>`;
        return `<Variation>${skuXml}<StartPrice currencyID="USD">${thisPrice}</StartPrice><VariationSpecifics>${specificsContent}</VariationSpecifics></Variation>`;
      }).join('');

      const picturesXml = extractVariationPictures(getItemXml);

      console.log(`listing/price: id=${cleanId} label="${label}" → ReviseFixedPriceItem (${varBlocks.length} variations, pictures=${picturesXml ? 'preserved' : 'none'})`);
      const body = `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${cleanId}</ItemID><Variations>${variationXml}${picturesXml}</Variations></Item></ReviseFixedPriceItemRequest>`;
      const { data: xml } = await tradingPost('ReviseFixedPriceItem', body);
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

// ── Remove a single variation from a multi-variation listing ─────────
router.delete('/listing/:id/variation', async (req, res) => {
  try {
    const token = await getAccessToken();
    const cleanId = String(req.params.id).trim().replace(/\D/g, '');
    if (!cleanId) return res.status(400).json({ error: 'Listing ID must be numeric' });
    const { variantLabel } = req.body;
    if (!variantLabel) return res.status(400).json({ error: 'variantLabel is required' });

    const label = variantLabel.toLowerCase().trim();
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
      const msgs = [];
      const errRe = /<Errors>([\s\S]*?)<\/Errors>/g;
      let em;
      while ((em = errRe.exec(xml)) !== null) {
        const sev = em[1].match(/<SeverityCode>([^<]+)<\/SeverityCode>/)?.[1] || '';
        if (sev === 'Warning') continue;
        const msg = em[1].match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1]
          || em[1].match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/)?.[1] || '';
        if (msg) msgs.push(msg);
      }
      return msgs.length ? msgs.join(' | ') : null;
    }

    const { data: getItemXml } = await tradingPost('GetItem',
      `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID></GetItemRequest>`
    );
    const getItemErr = checkFailure(getItemXml);
    if (getItemErr) return res.status(400).json({ error: getItemErr });

    const varBlocks = [];
    const varRe = /<Variation>([\s\S]*?)<\/Variation>/g;
    let vm;
    while ((vm = varRe.exec(getItemXml)) !== null) varBlocks.push(vm[0]);

    if (varBlocks.length === 0) return res.json({ ok: true, removed: false, message: 'No variations found' });

    const kept = varBlocks.filter(vBlock => {
      const nvRe = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
      let nv;
      while ((nv = nvRe.exec(vBlock)) !== null) {
        const raw = nv[1].match(/<Value>([\s\S]*?)<\/Value>/)?.[1] || '';
        const val = raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").toLowerCase();
        if (val === label || label.includes(val) || val.includes(label)) return false;
      }
      return true;
    });

    if (kept.length === varBlocks.length) return res.json({ ok: true, removed: false, message: 'Variation not found in listing' });
    if (kept.length === 0) return res.json({ ok: true, removed: true, message: 'Last variation — listing will be ended separately' });

    const toDelete = varBlocks.filter(vBlock => !kept.includes(vBlock));

    const keptXml = kept.map(vBlock => {
      const currentPriceM = vBlock.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/);
      const currentPrice = currentPriceM ? parseFloat(currentPriceM[1]).toFixed(2) : '0.00';
      const specificsContent = vBlock.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
      const sku = vBlock.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
      const varVal = vBlock.match(/<Value>([\s\S]*?)<\/Value>/)?.[1] || '';
      const skuXml = sku ? `<SKU>${sku}</SKU>` : `<SKU>${sanitizeSku(`${cleanId}-${varVal}`)}</SKU>`;
      const qty = vBlock.match(/<Quantity>([\d]+)<\/Quantity>/)?.[1] || '1';
      return `<Variation>${skuXml}<StartPrice currencyID="USD">${currentPrice}</StartPrice><Quantity>${qty}</Quantity><VariationSpecifics>${specificsContent}</VariationSpecifics></Variation>`;
    }).join('');

    // eBay requires explicit <Delete>true</Delete> on removed variations — omitting them is not enough.
    const deletedXml = toDelete.map(vBlock => {
      const specificsContent = vBlock.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
      const sku = vBlock.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
      const skuXml = sku ? `<SKU>${sku}</SKU>` : '';
      return `<Variation>${skuXml}<VariationSpecifics>${specificsContent}</VariationSpecifics><Delete>true</Delete></Variation>`;
    }).join('');

    const picturesXml = extractVariationPictures(getItemXml);
    const variationXml = keptXml + deletedXml;
    const body = `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${cleanId}</ItemID><Variations>${variationXml}${picturesXml}</Variations></Item></ReviseFixedPriceItemRequest>`;
    const { data: xml } = await tradingPost('ReviseFixedPriceItem', body);
    const err = checkFailure(xml);
    if (err) {
      // eBay blocks deletion of variations with completed transactions.
      // Fall back to qty=0 so the variation is hidden from buyers but stays on eBay.
      const isTransactionBlock = /transaction|sold|cannot (delete|remove|modify)/i.test(err);
      if (isTransactionBlock) {
        const zeroXml = toDelete.map(vBlock => {
          const price = vBlock.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || '0.00';
          const specificsContent = vBlock.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
          const sku = vBlock.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
          const skuXml = sku ? `<SKU>${sku}</SKU>` : '';
          return `<Variation>${skuXml}<StartPrice currencyID="USD">${parseFloat(price).toFixed(2)}</StartPrice><Quantity>0</Quantity><VariationSpecifics>${specificsContent}</VariationSpecifics></Variation>`;
        }).join('');
        const fallbackBody = `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${cleanId}</ItemID><Variations>${keptXml}${zeroXml}${picturesXml}</Variations></Item></ReviseFixedPriceItemRequest>`;
        const { data: fallbackXml } = await tradingPost('ReviseFixedPriceItem', fallbackBody);
        const fallbackErr = checkFailure(fallbackXml);
        if (fallbackErr) return res.status(400).json({ error: fallbackErr });
        return res.json({ ok: true, removed: false, zeroed: true, keptCount: kept.length, message: 'Variation has sales history — set to qty 0 instead of deleting' });
      }
      return res.status(400).json({ error: err });
    }

    res.json({ ok: true, removed: true, keptCount: kept.length });
  } catch (err) {
    if (err.response?.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message || 'Failed to remove variation' });
  }
});

// ── Add a new variation to an existing multi-variation listing ────────
router.post('/listing/:id/add-variation', async (req, res) => {
  try {
    const token = await getAccessToken();
    const cleanId = String(req.params.id).trim().replace(/\D/g, '');
    if (!cleanId) return res.status(400).json({ error: 'Listing ID must be numeric' });
    const { variantLabel, price } = req.body;
    if (!variantLabel || !price || isNaN(Number(price)) || Number(price) <= 0)
      return res.status(400).json({ error: 'variantLabel and price are required' });

    const priceStr = Number(price).toFixed(2);
    const label = variantLabel.trim();

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
      const msgs = [];
      const errRe = /<Errors>([\s\S]*?)<\/Errors>/g;
      let em;
      while ((em = errRe.exec(xml)) !== null) {
        const sev = em[1].match(/<SeverityCode>([^<]+)<\/SeverityCode>/)?.[1] || '';
        if (sev === 'Warning') continue;
        const msg = em[1].match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1]
          || em[1].match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/)?.[1] || '';
        if (msg) msgs.push(msg);
      }
      return msgs.length ? msgs.join(' | ') : null;
    }

    // Read current listing to get existing variations + dimension name
    const { data: getItemXml } = await tradingPost('GetItem',
      `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID></GetItemRequest>`
    );
    const getItemErr = checkFailure(getItemXml);
    if (getItemErr) return res.status(400).json({ error: getItemErr });

    const varBlocks = [];
    const varRe = /<Variation>([\s\S]*?)<\/Variation>/g;
    let vm;
    while ((vm = varRe.exec(getItemXml)) !== null) varBlocks.push(vm[0]);
    if (varBlocks.length === 0) return res.status(400).json({ error: 'Listing has no variations — cannot add a variation to a single-item listing' });

    // Detect the variation dimension name — two-step extraction with trim() to avoid
    // whitespace in captured values causing a mismatch on ReviseFixedPriceItem
    const _specSetBlock  = getItemXml.match(/<VariationSpecificsSet>([\s\S]*?)<\/VariationSpecificsSet>/)?.[1] || '';
    const _firstVarSpecs = (varBlocks[0] || '').match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
    const dimName =
      _specSetBlock.match(/<Name>([\s\S]*?)<\/Name>/)?.[1]?.trim()
      || _firstVarSpecs.match(/<Name>([\s\S]*?)<\/Name>/)?.[1]?.trim()
      || getItemXml.match(/<VariationSpecificName>([\s\S]*?)<\/VariationSpecificName>/)?.[1]?.trim()
      || 'Style';
    console.log(`add-variation: listing ${cleanId} dimName="${dimName}"`);

    // Check the new label doesn't already exist
    const existingLabels = varBlocks.map(b => {
      const raw = b.match(/<Value>([\s\S]*?)<\/Value>/)?.[1] || '';
      return raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    });
    if (existingLabels.some(l => l.toLowerCase() === label.toLowerCase()))
      return res.status(409).json({ error: `Variation "${label}" already exists on this listing` });

    // Rebuild existing variation XML preserving prices and SKUs
    const existingXml = varBlocks.map(vBlock => {
      const currentPriceM = vBlock.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/);
      const currentPrice = currentPriceM ? parseFloat(currentPriceM[1]).toFixed(2) : '0.00';
      const specificsContent = vBlock.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
      const sku = vBlock.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
      const qty = vBlock.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] || '1';
      const skuXml = `<SKU>${sku || sanitizeSku(`${cleanId}-${existingLabels[varBlocks.indexOf(vBlock)]}`)}</SKU>`;
      return `<Variation>${skuXml}<StartPrice currencyID="USD">${currentPrice}</StartPrice><Quantity>${qty}</Quantity><VariationSpecifics>${specificsContent}</VariationSpecifics></Variation>`;
    }).join('');

    // New variation XML
    const newSku = sanitizeSku(`${cleanId}-${label}`);
    const newVarXml = `<Variation><SKU>${newSku}</SKU><StartPrice currencyID="USD">${priceStr}</StartPrice><Quantity>1</Quantity><VariationSpecifics><NameValueList><Name>${escXml(dimName)}</Name><Value>${escXml(label)}</Value></NameValueList></VariationSpecifics></Variation>`;

    // VariationSpecificsSet must list ALL valid values including the new one —
    // without this eBay rejects the new value as not matching the listing's spec set.
    const allValues = [...existingLabels, label];
    const specSetXml = `<VariationSpecificsSet><NameValueList><Name>${escXml(dimName)}</Name>${allValues.map(v => `<Value>${escXml(v)}</Value>`).join('')}</NameValueList></VariationSpecificsSet>`;

    const picturesXml = extractVariationPictures(getItemXml);
    const body = `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${cleanId}</ItemID><Variations>${existingXml}${newVarXml}${specSetXml}${picturesXml}</Variations></Item></ReviseFixedPriceItemRequest>`;
    const { data: xml } = await tradingPost('ReviseFixedPriceItem', body);
    const err = checkFailure(xml);
    if (err) return res.status(400).json({ error: err });

    console.log(`add-variation: added "${label}" at $${priceStr} to listing ${cleanId}`);
    res.json({ ok: true, label, price: priceStr, totalVariations: varBlocks.length + 1 });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message || 'Failed to add variation' });
  }
});

// ── Get + optionally trim pictures on a listing ───────────────────────
// GET  → returns current picture URLs
// POST with { keepCount: N } → trims to first N pictures via ReviseFixedPriceItem
router.get('/listing/:id/pictures', async (req, res) => {
  try {
    const token = await getAccessToken();
    const cleanId = String(req.params.id).trim().replace(/\D/g, '');
    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
    const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll',
      `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID></GetItemRequest>`,
      { headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-CALL-NAME': 'GetItem', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' } }
    );
    const pics = [...xml.matchAll(/<PictureURL>([\s\S]*?)<\/PictureURL>/g)].map(m => m[1].trim());
    res.json({ listingId: cleanId, count: pics.length, pictures: pics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/listing/:id/trim-pictures', async (req, res) => {
  try {
    const { keepCount } = req.body;
    if (!keepCount || keepCount < 1) return res.status(400).json({ error: 'keepCount required' });
    const token = await getAccessToken();
    const cleanId = String(req.params.id).trim().replace(/\D/g, '');
    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
    // Get current pictures
    const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll',
      `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID></GetItemRequest>`,
      { headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-CALL-NAME': 'GetItem', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' } }
    );
    const pics = [...xml.matchAll(/<PictureURL>([\s\S]*?)<\/PictureURL>/g)].map(m => m[1].trim());
    if (pics.length <= keepCount) return res.json({ ok: true, message: `Already has ${pics.length} pictures, nothing to trim`, pictures: pics });
    const kept = pics.slice(0, keepCount);
    const picXml = kept.map(u => `<PictureURL>${u}</PictureURL>`).join('');
    const { data: revXml } = await axios.post('https://api.ebay.com/ws/api.dll',
      `<?xml version="1.0" encoding="utf-8"?><ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${cleanId}</ItemID><PictureDetails>${picXml}</PictureDetails></Item></ReviseFixedPriceItemRequest>`,
      { headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' } }
    );
    if (/<Ack>Failure<\/Ack>/.test(revXml)) {
      const err = revXml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1] || 'eBay error';
      return res.status(400).json({ error: err });
    }
    console.log(`trim-pictures: listing ${cleanId} trimmed ${pics.length} → ${keepCount} pictures`);
    res.json({ ok: true, removed: pics.length - keepCount, kept: keepCount, pictures: kept });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Rename a variation label on a listing ─────────────────────────────
router.post('/listing/:id/rename-variation', async (req, res) => {
  try {
    const token = await getAccessToken();
    const cleanId = String(req.params.id).trim().replace(/\D/g, '');
    if (!cleanId) return res.status(400).json({ error: 'Listing ID must be numeric' });
    const { oldLabel, newLabel } = req.body;
    if (!oldLabel || !newLabel) return res.status(400).json({ error: 'oldLabel and newLabel are required' });

    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
    function tradingPost(callName, body) {
      return axios.post('https://api.ebay.com/ws/api.dll',
        `<?xml version="1.0" encoding="utf-8"?>${body}`,
        { headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml', 'X-EBAY-API-CALL-NAME': callName } }
      );
    }
    function checkFailure(xml) {
      if (!/<Ack>Failure<\/Ack>/.test(xml) && !/<Ack>PartialFailure<\/Ack>/.test(xml)) return null;
      const msgs = [];
      const errRe = /<Errors>([\s\S]*?)<\/Errors>/g; let em;
      while ((em = errRe.exec(xml)) !== null) {
        const sev = em[1].match(/<SeverityCode>([^<]+)<\/SeverityCode>/)?.[1] || '';
        if (sev === 'Warning') continue;
        const msg = em[1].match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1] || em[1].match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/)?.[1] || '';
        if (msg) msgs.push(msg);
      }
      return msgs.length ? msgs.join(' | ') : null;
    }

    const { data: getItemXml } = await tradingPost('GetItem',
      `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID></GetItemRequest>`
    );
    const getErr = checkFailure(getItemXml);
    if (getErr) return res.status(400).json({ error: getErr });

    const varBlocks = [...getItemXml.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)].map(m => m[0]);
    if (!varBlocks.length) return res.status(400).json({ error: 'No variations found on this listing' });

    const decode = s => (s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const escXml = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    const oldLower = oldLabel.toLowerCase().trim();
    let found = false;
    const variationXml = varBlocks.map(block => {
      const valueRaw = block.match(/<Value>([\s\S]*?)<\/Value>/i)?.[1] || '';
      const decoded = decode(valueRaw).toLowerCase().trim();
      const isTarget = decoded === oldLower;
      if (isTarget) found = true;
      const label = isTarget ? newLabel : decode(valueRaw);
      const price = block.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || '0.00';
      const qty   = block.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] || '1';
      const sku   = block.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
      const skuXml = `<SKU>${sku || (cleanId + '-' + label.replace(/[^a-zA-Z0-9]/g, '')).slice(0, 50)}</SKU>`;
      const dimName = block.match(/<Name>([\s\S]*?)<\/Name>/)?.[1]?.trim() || 'Style';
      return `<Variation>${skuXml}<StartPrice currencyID="USD">${parseFloat(price).toFixed(2)}</StartPrice><Quantity>${qty}</Quantity><VariationSpecifics><NameValueList><Name>${escXml(dimName)}</Name><Value>${escXml(label)}</Value></NameValueList></VariationSpecifics></Variation>`;
    }).join('');

    if (!found) return res.status(404).json({ error: `Variation "${oldLabel}" not found on listing ${cleanId}` });

    // Rebuild VariationSpecificsSet with updated label
    const specSetBlock = getItemXml.match(/<VariationSpecificsSet>([\s\S]*?)<\/VariationSpecificsSet>/)?.[1] || '';
    const dimName = specSetBlock.match(/<Name>([\s\S]*?)<\/Name>/)?.[1]?.trim() || 'Style';
    const allValues = varBlocks.map(b => {
      const raw = decode(b.match(/<Value>([\s\S]*?)<\/Value>/i)?.[1] || '');
      return raw.toLowerCase().trim() === oldLower ? newLabel : raw;
    });
    const specSetXml = `<VariationSpecificsSet><NameValueList><Name>${escXml(dimName)}</Name>${allValues.map(v => `<Value>${escXml(v)}</Value>`).join('')}</NameValueList></VariationSpecificsSet>`;
    // Also update the old label inside the Pictures block (VariationSpecificValue tags)
    const rawPictures = getItemXml.match(/<Variations>[\s\S]*?(<Pictures>[\s\S]*?<\/Pictures>)[\s\S]*?<\/Variations>/)?.[1] || '';
    const picturesXml = rawPictures.replace(
      new RegExp(`<VariationSpecificValue>${escXml(oldLabel)}<\/VariationSpecificValue>`, 'gi'),
      `<VariationSpecificValue>${escXml(newLabel)}</VariationSpecificValue>`
    );

    const { data: reviseXml } = await tradingPost('ReviseFixedPriceItem',
      `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${cleanId}</ItemID><Variations>${variationXml}${specSetXml}${picturesXml}</Variations></Item></ReviseFixedPriceItemRequest>`
    );
    const err = checkFailure(reviseXml);
    if (err) return res.status(400).json({ error: err });

    console.log(`rename-variation: listing ${cleanId} "${oldLabel}" → "${newLabel}"`);
    res.json({ ok: true, listingId: cleanId, oldLabel, newLabel });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to rename variation' });
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


// ── Bulk set quantity on all active listings ───────────────────────────
router.post('/bulk-set-quantity', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { quantity = 1 } = req.body;
    const qty = Math.max(1, parseInt(quantity) || 1);

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

    // Fetch all active listing IDs
    const { data: listXml } = await tradingPost('GetMyeBaySelling',
      `<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></ActiveList></GetMyeBaySellingRequest>`
    );
    const itemIds = [...listXml.matchAll(/<ItemID>(\d+)<\/ItemID>/g)].map(m => m[1]);
    const uniqueIds = [...new Set(itemIds)];

    const results = { done: 0, failed: 0, errors: [] };

    for (const itemId of uniqueIds) {
      try {
        // Read current variations
        const { data: getXml } = await tradingPost('GetItem',
          `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${itemId}</ItemID></GetItemRequest>`
        );

        const varBlocks = [...getXml.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)].map(m => m[0]);

        let body;
        if (varBlocks.length) {
          const variationXml = varBlocks.map(vBlock => {
            const specificsContent = vBlock.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
            const price = vBlock.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || '0';
            const sku = vBlock.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
            const varVal = vBlock.match(/<Value>([\s\S]*?)<\/Value>/)?.[1] || '';
            const skuXml = `<SKU>${sku || sanitizeSku(`${itemId}-${varVal}`)}</SKU>`;
            return `<Variation>${skuXml}<StartPrice currencyID="USD">${parseFloat(price).toFixed(2)}</StartPrice><Quantity>${qty}</Quantity><VariationSpecifics>${specificsContent}</VariationSpecifics></Variation>`;
          }).join('');
          const picturesXml = extractVariationPictures(getXml);
          body = `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${itemId}</ItemID><Variations>${variationXml}${picturesXml}</Variations></Item></ReviseFixedPriceItemRequest>`;
        } else {
          body = `<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<InventoryStatus><ItemID>${itemId}</ItemID><Quantity>${qty}</Quantity></InventoryStatus></ReviseInventoryStatusRequest>`;
        }

        const callName = varBlocks.length ? 'ReviseFixedPriceItem' : 'ReviseInventoryStatus';
        const { data: revXml } = await tradingPost(callName, body);

        if (/<Ack>Failure<\/Ack>/.test(revXml)) {
          const msg = revXml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1] || 'eBay error';
          results.failed++;
          results.errors.push({ itemId, error: msg });
        } else {
          results.done++;
        }
      } catch (err) {
        results.failed++;
        results.errors.push({ itemId, error: err.message });
      }
    }

    console.log(`bulk-set-quantity: qty=${qty} done=${results.done} failed=${results.failed}`);
    res.json({ ...results, total: uniqueIds.length });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message || 'Failed to set quantity' });
  }
});

// ── Set quantity on a single listing ──────────────────────────────────
router.post('/listing/:id/quantity', async (req, res) => {
  try {
    const token = await getAccessToken();
    const cleanId = String(req.params.id).trim().replace(/\D/g, '');
    if (!cleanId) return res.status(400).json({ error: 'Listing ID must be numeric' });
    const { quantity = 1 } = req.body;
    const qty = Math.max(1, parseInt(quantity) || 1);

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

    const { data: getXml } = await tradingPost('GetItem',
      `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID></GetItemRequest>`
    );

    const varBlocks = [...getXml.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)].map(m => m[0]);

    let body, callName;
    if (varBlocks.length) {
      const variationXml = varBlocks.map(vBlock => {
        const specificsContent = vBlock.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
        const price = vBlock.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || '0';
        const sku = vBlock.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
        const varVal = vBlock.match(/<Value>([\s\S]*?)<\/Value>/)?.[1] || '';
        const skuXml = `<SKU>${sku || sanitizeSku(`${cleanId}-${varVal}`)}</SKU>`;
        return `<Variation>${skuXml}<StartPrice currencyID="USD">${parseFloat(price).toFixed(2)}</StartPrice><Quantity>${qty}</Quantity><VariationSpecifics>${specificsContent}</VariationSpecifics></Variation>`;
      }).join('');
      const picturesXml = extractVariationPictures(getXml);
      body = `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${cleanId}</ItemID><Variations>${variationXml}${picturesXml}</Variations></Item></ReviseFixedPriceItemRequest>`;
      callName = 'ReviseFixedPriceItem';
    } else {
      body = `<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<InventoryStatus><ItemID>${cleanId}</ItemID><Quantity>${qty}</Quantity></InventoryStatus></ReviseInventoryStatusRequest>`;
      callName = 'ReviseInventoryStatus';
    }

    const { data: revXml } = await tradingPost(callName, body);
    const err = checkFailure(revXml);
    if (err) return res.status(400).json({ error: err });

    console.log(`listing/quantity: id=${cleanId} qty=${qty} variations=${varBlocks.length}`);
    res.json({ ok: true, quantity: qty, variations: varBlocks.length });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message || 'Failed to set quantity' });
  }
});

// ── Create listing via Trading API (AddFixedPriceItem) ─────────────────
// More reliable than Inventory API for accounts that haven't been approved
// for programmatic listing creation via the Inventory API.
router.post('/trading-create-listing', async (req, res) => {
  try {
    const token = await getAccessToken();
    const {
      title, price: _price, currency = 'USD', quantity = 1,
      condition = 'NEW', categoryId,
      imageUrls = [], upc, specs = {}, bullets = [], description,
      variants, // [{ label, price, quantity }] for multi-variation
      variantDimension = 'Color', // e.g. 'Color', 'Size', 'Style'
      shipping = { free: true, carrier: 'FedExStandardOvernight', handlingDays: 2 },
      returns = { accepted: true, days: 30, buyerPays: true },
      // Seller location — defaults match account registered location
      sellerCountry = 'TH',
      sellerLocation = 'Phayao',
    } = req.body;

    if (!title || !_price) return res.status(400).json({ error: 'title and price are required' });
    if (Number(_price) >= 100) return res.status(400).json({ error: `Listing price $${Number(_price).toFixed(2)} is $100 or more — eBay requires account approval for premium listings. Keep price under $100.` });
    let price = String(_price);

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

    // Fill remaining unfilled aspects (required + recommended) using product specs, bullets,
    // and variant labels (e.g. "9 Months", "Blue") so Claude can infer Size/Color/etc.
    const variantLabels = (variants || []).map(v => v.label).filter(Boolean);
    await enrichAspectsWithAI(catId, aspects, safeTitle, specs, bullets, variantLabels);

    // For multi-variation listings, the variantDimension (Color/Size/Style) MUST NOT appear
    // in ItemSpecifics — eBay error 21916626 fires if the same name appears in both.
    // Exception: single-variant listings have no variation conflict, so keep the dimension
    // as an item specific (e.g. Size="9 Months" on a single-size baby shirt).
    // Save the value first: if eBay rejects this dimension (21920061) and we switch to another,
    // the saved value gets restored as a required item specific on the retry.
    // Single-variant products must NOT use multi-SKU format — eBay requires 2+ variations.
    // List them as plain single items; include the variant label as a Style item specific.
    const isMultiVariation = (variants?.length || 0) > 1;
    console.log(`trading-create-listing: variants=${variants?.length || 0} isMultiVariation=${isMultiVariation}`);
    if ((variants?.length || 0) === 1 && variants[0]?.label) {
      aspects['Style'] = [variants[0].label];
      if (variants[0].price) price = String(Number(variants[0].price).toFixed(2));
    }

    const savedVarDimAspect = (isMultiVariation && variantDimension) ? (aspects[variantDimension] || null) : null;
    if (isMultiVariation && variantDimension) delete aspects[variantDimension];

    const buildSpecXml = (asp) => Object.entries(asp)
      .map(([name, vals]) => `<NameValueList><Name>${escXml(name)}</Name>${vals.map(v => `<Value>${escXml(String(v))}</Value>`).join('')}</NameValueList>`)
      .join('');

    // Build pictures XML (max 12, deduplicated)
    const pics = [...new Set(imageUrls)].slice(0, 12);
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
    if (isMultiVariation) {
      const variationsXml = variants.map(v => {
        const varPrice = v.price || price;
        return `<Variation>
          <StartPrice currencyID="USD">${Number(varPrice).toFixed(2)}</StartPrice>
          <Quantity>${Number(v.quantity) || 1}</Quantity>
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
      if (isMultiVariation) {
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
            <DispatchTimeMax>${Number(shipping.handlingDays) || 2}</DispatchTimeMax>
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
            <DispatchTimeMax>${Number(shipping.handlingDays) || 2}</DispatchTimeMax>
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

    // Helper to rebuild varSpecsXml with a different dimension name (used for 21920061 fallback)
    function rebuildVarSpecsXml(dim) {
      if (!variants?.length) return '';
      const varXml = variants.map(v => {
        const varPrice = v.price || price;
        return `<Variation>
          <StartPrice currencyID="USD">${Number(varPrice).toFixed(2)}</StartPrice>
          <Quantity>${Number(v.quantity) || 1}</Quantity>
          <VariationSpecifics>
            <NameValueList><Name>${escXml(dim)}</Name><Value>${escXml(v.label)}</Value></NameValueList>
          </VariationSpecifics>
        </Variation>`;
      }).join('');
      const withImgs = variants.filter(v => v.images?.length || v.image);
      const picXml = withImgs.length ? `<Pictures>
        <VariationSpecificName>${escXml(dim)}</VariationSpecificName>
        ${withImgs.map(v => { const imgs = v.images?.length ? v.images : (v.image ? [v.image] : []); return `<VariationSpecificPictureSet><VariationSpecificValue>${escXml(v.label)}</VariationSpecificValue>${imgs.map(img => `<PictureURL>${escXml(img)}</PictureURL>`).join('')}</VariationSpecificPictureSet>`; }).join('')}
      </Pictures>` : '';
      return `<Variations>${varXml}<VariationSpecificsSet><NameValueList><Name>${escXml(dim)}</Name>${variants.map(v => `<Value>${escXml(v.label)}</Value>`).join('')}</NameValueList></VariationSpecificsSet>${picXml}</Variations>`;
    }

    // First attempt
    let xml;
    let activeDimension = variantDimension; // tracks the dimension currently in varSpecsXml
    ({ data: xml } = await tradingPost('AddFixedPriceItem', buildBody(buildSpecXml(aspects))));

    // 21920061 — this dimension is not allowed as a variation specific for this category.
    // Fall back through Color → Size until eBay accepts one.
    if (!/<ItemID>\d+<\/ItemID>/.test(xml) && /<ErrorCode>21920061<\/ErrorCode>/.test(xml) && isMultiVariation) {
      const fallbacks = ['Color', 'Size', 'Style'].filter(d => d !== activeDimension);
      for (const fallbackDim of fallbacks) {
        console.log(`trading-create-listing: 21920061 — "${activeDimension}" not allowed for cat ${catId}, retrying with "${fallbackDim}"`);
        varSpecsXml = rebuildVarSpecsXml(fallbackDim);
        // Restore the old dimension's value as a required item specific now that it's no
        // longer the variation dim (e.g. Style="Sun Hat" for a hats category listing).
        if (savedVarDimAspect) aspects[variantDimension] = savedVarDimAspect;
        delete aspects[fallbackDim]; // prevent new dim from appearing in item specifics
        activeDimension = fallbackDim;
        ({ data: xml } = await tradingPost('AddFixedPriceItem', buildBody(buildSpecXml(aspects))));
        if (/<ItemID>\d+<\/ItemID>/.test(xml) || !/<ErrorCode>21920061<\/ErrorCode>/.test(xml)) break;
      }
    }

    // 21916564 — category doesn't support multi-variation: strip variants and retry as single listing
    let usedSingleItemFallback = false;
    if (!/<ItemID>\d+<\/ItemID>/.test(xml) && /<ErrorCode>21916564<\/ErrorCode>/.test(xml) && isMultiVariation) {
      usedSingleItemFallback = true;
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
            <DispatchTimeMax>${Number(shipping.handlingDays) || 2}</DispatchTimeMax>
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
            // Fallback: if no valid value found, use 'Other' so the listing isn't blocked
            if (!aspects[f]) aspects[f] = ['Other'];
          }
        }
        // If the variantDimension is also a required item specific, we have a conflict:
        // eBay requires it in ItemSpecifics but also forbids it there when it's the variation dim.
        // Resolve by switching the variation to a different dimension so the item specific can stay.
        if (isMultiVariation && variantDimension) {
          if (missingFields.includes(variantDimension)) {
            const altDim = ['Color', 'Size', 'Style'].find(d => d !== variantDimension);
            if (altDim) {
              console.log(`trading-create-listing: "${variantDimension}" is both a required item specific and the variation dim — switching variation to "${altDim}"`);
              varSpecsXml = rebuildVarSpecsXml(altDim);
              delete aspects[altDim];
            }
            // Keep aspects[variantDimension] — it stays as a required item specific
          } else {
            delete aspects[variantDimension];
          }
        }
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
        if (sev === 'Warning') continue;
        const code = em[1].match(/<ErrorCode>([^<]+)<\/ErrorCode>/)?.[1] || '';
        const long = em[1].match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1] || '';
        const short = em[1].match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/)?.[1] || '';
        // ErrorParameters contain the real reason for errors like 240 (premium item block)
        const paramVals = [...em[1].matchAll(/<ErrorParameters[^>]*>\s*<Value>([\s\S]*?)<\/Value>/g)]
          .map(p => p[1].replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim())
          .filter(Boolean);
        const detail = paramVals[0] || long || short;
        allMsgs.push(`[${code}] ${detail}`);
      }
      const msg = allMsgs.join(' | ') || xml.slice(0, 600);
      const allCodes = [...xml.matchAll(/<ErrorCode>([^<]+)<\/ErrorCode>/g)].map(m => m[1]);
      const allSevs  = [...xml.matchAll(/<SeverityCode>([^<]+)<\/SeverityCode>/g)].map(m => m[1]);
      const allLongs = [...xml.matchAll(/<LongMessage>([\s\S]*?)<\/LongMessage>/g)].map(m => m[1].slice(0, 120));
      console.error('trading-create-listing errors:', allCodes.map((c, i) => `[${c}/${allSevs[i] || '?'}] ${allLongs[i] || ''}`).join(' | '));
      console.error('trading-create-listing failure XML:\n', xml.slice(0, 2500));
      // [240] = eBay selling velocity / limit block — return 429 so callers can detect and stop
      if (allMsgs.some(m => m.startsWith('[240]'))) {
        return res.status(429).json({ error: 'selling_limit_reached', message: msg });
      }
      return res.status(400).json({ error: msg });
    }

    if (!listingId) return res.status(500).json({ error: 'Listing created but could not extract ItemID', raw: xml.slice(0, 500) });

    // Link the tracked product record(s) to this listing in the SAME request that created it —
    // deliberately not left to a separate PATCH call from the frontend afterward. A real incident
    // (2026-07-12) had the eBay listing created successfully but the client's follow-up PATCH
    // never landed (a backend redeploy cut the connection), leaving a live, fully-paid-for eBay
    // listing with no ebayListingId anywhere in the DB — invisible to price sync, Deals/Tracker,
    // and at risk of the orphan-cleanup job ending it outright. Doing the link here means it can
    // only be missing if the listing creation itself failed too, in which case there's nothing to
    // link — not as a side effect of a network hiccup after the hard part already succeeded.
    const linkFailures = [];
    const productLinks = (variants || []).filter(v => v.productId);
    for (const v of productLinks) {
      try {
        const updated = await Product.findByIdAndUpdate(v.productId, {
          ebayListingId: listingId,
          cloudinaryFolder: v.cloudinaryFolder || null,
          listedAt: new Date(),
        }, { new: true });
        if (!updated) linkFailures.push(v.productId);
      } catch (e) {
        console.error(`trading-create-listing: failed to link product ${v.productId} to ${listingId}:`, e.message);
        linkFailures.push(v.productId);
      }
    }

    res.json({ listingId, url: `https://www.ebay.com/itm/${listingId}`, isMultiVariation: !usedSingleItemFallback, ...(linkFailures.length ? { linkFailures } : {}) });
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
      const errCode = xml.match(/<ErrorCode>(\d+)<\/ErrorCode>/)?.[1];
      const longMsg = (xml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1] || '').toLowerCase();
      const isGone = errCode === '17' || longMsg.includes('no such') || longMsg.includes('invalid item') || longMsg.includes('not found for itemid');
      return res.status(isGone ? 404 : 400).json({ error: isGone ? 'not_found' : 'api_error' });
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

// ── Batch live prices for multiple listings — one call per listing (GetItem) ──────
// ?ids=123,456,789  Returns { "123": { base, variations }, ... }
router.get('/listings/prices-batch', async (req, res) => {
  const rawIds = String(req.query.ids || '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
  if (!rawIds.length) return res.status(400).json({ error: 'ids required' });
  try {
    const token = await getAccessToken();
    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
    const headers = { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' };

    const result = {};
    await Promise.all(rawIds.map(async cleanId => {
      try {
        const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll',
          `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID><IncludeItemSpecifics>true</IncludeItemSpecifics></GetItemRequest>`,
          { headers: { ...headers, 'X-EBAY-API-CALL-NAME': 'GetItem' } }
        );
        if (/<Ack>Failure<\/Ack>/.test(xml)) {
          const errCode = xml.match(/<ErrorCode>(\d+)<\/ErrorCode>/)?.[1];
          const longMsg = (xml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1] || '').toLowerCase();
          // ErrorCode 17 = item not found/ended; only mark as gone for that specific error
          const isGone = errCode === '17' || longMsg.includes('no such') || longMsg.includes('invalid item') || longMsg.includes('not found for itemid');
          result[cleanId] = { error: isGone ? 'not_found' : 'api_error' };
          return;
        }
        const baseMatch = xml.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/);
        const base = baseMatch ? parseFloat(baseMatch[1]) : 0;
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
            const value = rawVal.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").toLowerCase();
            if (name && value) specs[name] = value;
          }
          variations.push({ price, specs });
        }
        result[cleanId] = { base, variations };
      } catch { result[cleanId] = { error: 'failed' }; }
    }));
    res.json(result);
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated') return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.message });
  }
});

// ── Get eBay listing view counts (batch — one Analytics API call for all IDs) ──
const VIEW_METRICS = ['LISTING_VIEWS_TOTAL'];
const viewsCache = new Map(); // listingId → { count, expiresAt }
const VIEWS_TTL = 6 * 60 * 60 * 1000; // 6 hour cache — Analytics API has tight rate limits
let viewsLastFetch = 0;            // timestamp of last successful batch fetch
const VIEWS_MIN_INTERVAL = 5 * 60 * 1000; // never hit Analytics more than once per 5 min

// Batch endpoint: GET /api/ebay/listings/views?ids=id1,id2,id3
// Returns { views: { id1: N, id2: N, ... } }
router.get('/listings/views', async (req, res) => {
  const rawIds = String(req.query.ids || '');
  const ids = [...new Set(rawIds.split(',').map(s => s.replace(/\D/g, '')).filter(Boolean))];
  if (!ids.length) return res.status(400).json({ error: 'ids query param required' });

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
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
    const now2 = Date.now();
    if (now2 - viewsLastFetch < VIEWS_MIN_INTERVAL) {
      // Too soon — serve zeros for uncached IDs rather than hitting the rate limit
      for (const id of uncached) result[id] = 0;
    } else {
      try {
        const token = await getAccessToken();
        const { data } = await axios.get('https://api.ebay.com/sell/analytics/v1/traffic_report', {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            dimension: 'LISTING',
            metric: VIEW_METRICS.join(','),
            filter: `listing_ids:{${uncached.join('|')}},date_range:[${fmt(start)}..${fmt(yesterday)}]`,
          },
        });
        viewsLastFetch = Date.now();
        for (const record of (data.records || [])) {
          const lid = String(record.dimensionValues?.[0]?.value || '');
          if (!lid) continue;
          const total = Number(record.metricValues?.[0]?.value ?? 0);
          result[lid] = total;
          viewsCache.set(lid, { count: total, expiresAt: Date.now() + VIEWS_TTL });
        }
        for (const id of uncached) {
          if (result[id] == null) result[id] = 0;
        }
      } catch (apiErr) {
        const errData = apiErr.response?.data;
        const isRateLimit = errData?.errors?.some?.(e => e.errorId === 2001);
        if (!isRateLimit) console.error('[eBay views] Analytics API error:', errData || apiErr.message);
        viewsLastFetch = Date.now(); // back off even on rate limit
        for (const id of uncached) result[id] = 0;
        return res.json({ views: result });
      }
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
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const start = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

    let views = 0;
    try {
      const { data } = await axios.get('https://api.ebay.com/sell/analytics/v1/traffic_report', {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          dimension: 'LISTING',
          metric: VIEW_METRICS.join(','),
          filter: `listing_ids:{${cleanId}},date_range:[${fmt(start)}..${fmt(yesterday)}]`,
        },
      });
      for (const record of (data.records || [])) {
        for (const m of (record.metricValues || [])) {
          if (m.value != null) views += Number(m.value);
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

const watchersCache = new Map(); // listingId → { count, expiresAt }
const WATCHERS_TTL = 60 * 60 * 1000; // 1 hour cache
let watchersLastFetch = 0;
const WATCHERS_MIN_INTERVAL = 2 * 60 * 1000; // throttle Trading API calls

// QuantitySold rides along on the same GetMyeBaySelling call as watchers — no extra API cost.
const soldCountCache = new Map(); // listingId → { count, expiresAt }

// Batch endpoint: GET /api/ebay/listings/watchers?ids=id1,id2,id3
// Returns { watchers: { id1: N, id2: N, ... }, sold: { id1: N, id2: N, ... } } — fetched via GetMyeBaySelling(IncludeWatchCount)
router.get('/listings/watchers', async (req, res) => {
  const rawIds = String(req.query.ids || '');
  const ids = [...new Set(rawIds.split(',').map(s => s.replace(/\D/g, '')).filter(Boolean))];
  if (!ids.length) return res.status(400).json({ error: 'ids query param required' });

  const result = {};
  const soldResult = {};
  const uncached = [];
  for (const id of ids) {
    const cached = watchersCache.get(id);
    const cachedSold = soldCountCache.get(id);
    if (cached && cached.expiresAt > Date.now()) result[id] = cached.count;
    else uncached.push(id);
    if (cachedSold && cachedSold.expiresAt > Date.now()) soldResult[id] = cachedSold.count;
  }

  if (uncached.length) {
    const now = Date.now();
    if (now - watchersLastFetch < WATCHERS_MIN_INTERVAL) {
      for (const id of uncached) result[id] = 0;
    } else {
      try {
        const token = await getAccessToken();
        watchersLastFetch = Date.now();
        for (let page = 1; page <= 2; page++) {
          const xml = `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ActiveList><Include>true</Include><IncludeWatchCount>true</IncludeWatchCount><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList></GetMyeBaySellingRequest>`;
          const { data: xmlResp } = await axios.post('https://api.ebay.com/ws/api.dll', xml, {
            headers: {
              'X-EBAY-API-SITEID': '0',
              'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
              'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
              'X-EBAY-API-IAF-TOKEN': token,
              'Content-Type': 'text/xml',
            },
          });
          if (/<Ack>Failure<\/Ack>/.test(xmlResp)) break;
          const itemRe = /<Item>([\s\S]*?)<\/Item>/g;
          let m;
          while ((m = itemRe.exec(xmlResp)) !== null) {
            const block = m[1];
            const get = tag => { const tm = block.match(new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`)); return tm ? tm[1].trim() : null; };
            const listingId = get('ItemID');
            if (!listingId) continue;
            const count = parseInt(get('WatchCount') || '0', 10) || 0;
            watchersCache.set(listingId, { count, expiresAt: Date.now() + WATCHERS_TTL });
            const soldCount = parseInt(get('QuantitySold') || '0', 10) || 0;
            soldCountCache.set(listingId, { count: soldCount, expiresAt: Date.now() + WATCHERS_TTL });
          }
          if (!/<HasMoreItems>true<\/HasMoreItems>/.test(xmlResp)) break;
        }
        for (const id of uncached) {
          const cached = watchersCache.get(id);
          result[id] = cached ? cached.count : 0;
          const cachedSold = soldCountCache.get(id);
          soldResult[id] = cachedSold ? cachedSold.count : 0;
        }
      } catch (apiErr) {
        console.error('[eBay watchers] Trading API error:', apiErr.response?.data || apiErr.message);
        for (const id of uncached) result[id] = 0;
        return res.json({ watchers: result, sold: soldResult });
      }
    }
  }

  res.json({ watchers: result, sold: soldResult });
});

// Batch endpoint: GET /api/ebay/listings/photo-status?ids=id1,id2,id3
// Returns { [id]: { hasPhoto: bool, count: int } } — one Trading API GetItem call per
// uncached id (batched 20 at a time in parallel), since the Shopping API's bulk
// GetMultipleItems host (open.api.ebay.com) has been retired by eBay and no longer resolves.
const photoStatusCache = new Map();
const PHOTO_STATUS_TTL = 30 * 60 * 1000; // 30 min

router.get('/listings/photo-status', async (req, res) => {
  const rawIds = String(req.query.ids || '');
  const ids = [...new Set(rawIds.split(',').map(s => s.replace(/\D/g, '')).filter(Boolean))];
  if (!ids.length) return res.json({});

  const result = {};
  const uncached = [];
  for (const id of ids) {
    const cached = photoStatusCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      result[id] = { hasPhoto: cached.hasPhoto, count: cached.count };
    } else {
      uncached.push(id);
    }
  }

  if (uncached.length) {
    const token = await getAccessToken();
    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

    for (let i = 0; i < uncached.length; i += 20) {
      const batch = uncached.slice(i, i + 20);
      await Promise.all(batch.map(async id => {
        try {
          const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll',
            `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${id}</ItemID><IncludeSelector>Details</IncludeSelector></GetItemRequest>`,
            { headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-CALL-NAME': 'GetItem', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' }, timeout: 10000 }
          );
          // Scope to the top-level gallery only — GetItem includes per-variation
          // <VariationSpecificPictureSet> blocks too, which would inflate this count.
          const pictureDetails = xml.match(/<PictureDetails>([\s\S]*?)<\/PictureDetails>/)?.[1] || '';
          const count = (pictureDetails.match(/<PictureURL>/g) || []).length;
          const entry = { hasPhoto: count > 0, count };
          result[id] = entry;
          photoStatusCache.set(id, { ...entry, expiresAt: Date.now() + PHOTO_STATUS_TTL });
        } catch {
          result[id] = { hasPhoto: null, count: 0 };
        }
      }));
    }
  }

  res.json(result);
});

// ── One-time backfill: populate listedAt for already-listed products ──
// using eBay's real listing StartTime (Trading API), for products that
// have an ebayListingId but no listedAt yet (listings created before
// listedAt tracking was added).
router.post('/backfill-listed-at', async (req, res) => {
  try {
    const products = await Product.find(
      { ebayListingId: { $exists: true, $ne: null }, listedAt: null },
      'ebayListingId'
    ).lean();
    if (!products.length) return res.json({ ok: true, updated: 0, message: 'Nothing to backfill' });

    const token = await getAccessToken();
    const startTimes = new Map(); // listingId → Date

    for (let page = 1; page <= 3; page++) {
      const xml = `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ActiveList><Include>true</Include><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList></GetMyeBaySellingRequest>`;
      const { data: xmlResp } = await axios.post('https://api.ebay.com/ws/api.dll', xml, {
        headers: {
          'X-EBAY-API-SITEID': '0',
          'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
          'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
          'X-EBAY-API-IAF-TOKEN': token,
          'Content-Type': 'text/xml',
        },
      });
      if (/<Ack>Failure<\/Ack>/.test(xmlResp)) break;
      const itemRe = /<Item>([\s\S]*?)<\/Item>/g;
      let m;
      while ((m = itemRe.exec(xmlResp)) !== null) {
        const block = m[1];
        const itemId = block.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];
        const startTime = block.match(/<StartTime>([\s\S]*?)<\/StartTime>/)?.[1];
        if (itemId && startTime) startTimes.set(itemId, new Date(startTime));
      }
      if (!/<HasMoreItems>true<\/HasMoreItems>/.test(xmlResp)) break;
    }

    let updated = 0;
    let notFound = 0;
    for (const p of products) {
      const cleanId = String(p.ebayListingId).replace(/\D/g, '');
      const startTime = startTimes.get(cleanId);
      if (!startTime) { notFound++; continue; }
      await Product.findByIdAndUpdate(p._id, { listedAt: startTime });
      updated++;
    }

    res.json({ ok: true, candidates: products.length, updated, notFoundOnEbay: notFound });
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    console.error('backfill-listed-at error:', err.response?.data || err.message);
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

      const needsHandlingFix = dispatch > 2;
      const needsReturnFix   = returnsAccepted !== 'ReturnsAccepted' || !['Days_30', 'Days_60'].includes(returnsWithin);

      if (!needsHandlingFix && !needsReturnFix) {
        return { id, ok: true, fixed: false, dispatch, returnsWithin };
      }

      // 2. Fix
      const newDispatch = needsHandlingFix ? 2 : dispatch;
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

// ── Manual trigger: auto-restock sold listings ─────────────────────────
router.post('/auto-restock', async (req, res) => {
  try {
    // getAccessToken is already available in this file's scope
    const token = await getAccessToken();
    const tradingHeaders = {
      'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml',
    };
    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
    function tradingPost(callName, body) {
      return axios.post('https://api.ebay.com/ws/api.dll', `<?xml version="1.0" encoding="utf-8"?>${body}`,
        { headers: { ...tradingHeaders, 'X-EBAY-API-CALL-NAME': callName } });
    }

    // Check last 24h so we can see recent orders in the test
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to   = new Date().toISOString();
    const { data: ordersXml } = await tradingPost('GetOrders',
      `<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<CreateTimeFrom>${from}</CreateTimeFrom><CreateTimeTo>${to}</CreateTimeTo><OrderStatus>Active</OrderStatus><DetailLevel>ReturnAll</DetailLevel></GetOrdersRequest>`
    );

    const transactions = [];
    for (const [, tx] of [...ordersXml.matchAll(/<Transaction>([\s\S]*?)<\/Transaction>/g)]) {
      const itemId = tx.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];
      const title  = tx.match(/<Title>([\s\S]*?)<\/Title>/)?.[1] || '';
      const qty    = tx.match(/<QuantityPurchased>(\d+)<\/QuantityPurchased>/)?.[1] || '1';
      const varVal = tx.match(/<Variation>[\s\S]*?<Value>([\s\S]*?)<\/Value>/)?.[1] || null;
      if (itemId) transactions.push({ itemId, title: title.slice(0, 50), qty, variant: varVal });
    }

    const restocked = [];
    for (const { itemId, varVal } of transactions) {
      try {
        await tradingPost('ReviseInventoryStatus',
          `<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<InventoryStatus><ItemID>${itemId}</ItemID><Quantity>1</Quantity></InventoryStatus></ReviseInventoryStatusRequest>`
        );
        restocked.push(itemId);
      } catch {}
    }

    res.json({ ordersFound: transactions.length, transactions, restocked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Manual trigger: auto-end listings 7+ days old with 0 views ────────
router.post('/auto-end-zero-views', async (req, res) => {
  try {
    const { autoEndZeroViews } = require('../jobs/trackerScheduler');
    await autoEndZeroViews();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Manual trigger: relist unsold listings that have views or watchers ──
router.post('/relist-unsold', async (req, res) => {
  try {
    const { relistUnsold } = require('../jobs/trackerScheduler');
    await relistUnsold();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Set up Promoted Listings Standard campaign at a given ad rate ──────
router.post('/promoted-listings/setup', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { listingIds, adRate = 2.0, campaignName = 'TingTongStore Promoted' } = req.body;
    if (!listingIds?.length) return res.status(400).json({ error: 'listingIds required' });

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const base = 'https://api.ebay.com/sell/marketing/v1';

    // Check for existing active campaign with same name
    const { data: existing } = await axios.get(`${base}/ad_campaign`, { headers }).catch(() => ({ data: { campaigns: [] } }));
    let campaignId = existing.campaigns?.find(c => c.campaignName === campaignName && c.campaignStatus === 'RUNNING')?.campaignId;

    // Create campaign if none exists
    if (!campaignId) {
      const { data: created } = await axios.post(`${base}/ad_campaign`, {
        campaignName,
        campaignStatus: 'RUNNING',
        fundingStrategy: { adRate, fundingModel: 'COST_PER_SALE' },
        marketplaceId: 'EBAY_US',
        startDate: new Date().toISOString(),
      }, { headers });
      campaignId = created.campaignId;
    }

    // Add listings to campaign using bulk endpoint
    const { data: bulkRes } = await axios.post(
      `${base}/ad_campaign/${campaignId}/bulk_create_ads_by_listing_id`,
      { requests: listingIds.map(id => ({ listingId: String(id), bidPercentage: Number(adRate).toFixed(1) })) },
      { headers }
    );

    const results = (bulkRes.responses || []).map((r, i) => {
      const alreadyExists = r.errors?.some(e => /already exists/i.test(e.message));
      return {
        listingId: listingIds[i],
        ok: !r.errors?.length || alreadyExists,
        error: alreadyExists ? null : r.errors?.[0]?.message || null,
      };
    });

    const done = results.filter(r => r.ok).length;
    console.log(`promoted-listings: campaign=${campaignId} rate=${adRate}% added=${done}/${listingIds.length}`);
    res.json({ campaignId, adRate, done, total: listingIds.length, results });
  } catch (err) {
    if (err.response?.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
    res.status(500).json({ error: err.response?.data?.errors?.[0]?.message || err.message });
  }
});

// ── End all Promoted Listings campaigns ────────────────────────────
router.post('/promoted-listings/end-all', async (req, res) => {
  try {
    const token = await getAccessToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const base = 'https://api.ebay.com/sell/marketing/v1';
    const { data } = await axios.get(`${base}/ad_campaign`, { headers }).catch(() => ({ data: { campaigns: [] } }));
    const active = (data.campaigns || []).filter(c => c.campaignStatus === 'RUNNING');
    const results = [];
    for (const c of active) {
      try {
        await axios.post(`${base}/ad_campaign/${c.campaignId}/end`, {}, { headers });
        results.push({ campaignId: c.campaignId, name: c.campaignName, ended: true });
        console.log(`promoted-listings: ended campaign ${c.campaignId} "${c.campaignName}"`);
      } catch (e) {
        results.push({ campaignId: c.campaignId, name: c.campaignName, ended: false, error: e.response?.data?.errors?.[0]?.message || e.message });
      }
    }
    res.json({ total: active.length, results });
  } catch (err) {
    if (err.response?.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
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
  let listingIds = Object.keys(groups);
  // Optional scope-down — e.g. the zero-view rescue job only wants to retitle the
  // specific listings it found dead, not run a full-catalog optimize pass.
  if (Array.isArray(req.body?.listingIds) && req.body.listingIds.length) {
    const only = new Set(req.body.listingIds.map(String));
    listingIds = listingIds.filter(id => only.has(id));
  }
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

// ── Bulk revise descriptions with current B2 image URLs ───────────────────────
// Targets every active eBay listing, regenerates description HTML using the
// product's current images (B2 URLs after migration), and pushes via ReviseFixedPriceItem.
// Trigger once after the Cloudinary→B2 migration + rescrape are complete.
// POST /api/ebay/bulk-revise-descriptions
router.post('/bulk-revise-descriptions', async (req, res) => {
  const BASE = `http://localhost:${process.env.PORT || 5000}`;

  const products = await Product.find({
    ebayListingId: { $exists: true, $ne: null },
    images: { $exists: true, $not: { $size: 0 } },
  }).lean();

  // Group by listingId; for each listing pick the variant with the most specs/images as primary
  const groups = {};
  for (const p of products) {
    if (!groups[p.ebayListingId]) groups[p.ebayListingId] = [];
    groups[p.ebayListingId].push(p);
  }
  const listingIds = Object.keys(groups);
  const total = listingIds.length;

  res.json({ started: true, total });

  // Process in background — concurrency 2 (each call costs Anthropic + eBay API)
  const sem = { running: 0, queue: [] };
  async function withLimit(fn) {
    if (sem.running >= 2) await new Promise(r => sem.queue.push(r));
    sem.running++;
    try { return await fn(); } finally {
      sem.running--;
      if (sem.queue.length) sem.queue.shift()();
    }
  }

  let done = 0, revised = 0, failed = 0;

  await Promise.all(listingIds.map(listingId => withLimit(async () => {
    const variants = groups[listingId];
    // Pick active variant with most data as primary
    const primary = variants
      .filter(v => v.status === 'active')
      .sort((a, b) => (Object.keys(b.specs || {}).length + (b.images?.length || 0)) - (Object.keys(a.specs || {}).length + (a.images?.length || 0)))[0]
      || variants[0];

    const imageUrls = (primary.images?.length ? primary.images : (primary.image ? [primary.image] : []))
      .filter(u => !u.includes('res.cloudinary.com')); // skip any Cloudinary URLs still in DB

    if (!imageUrls.length) {
      done++;
      console.log(`bulk-revise-descriptions [${done}/${total}] ${listingId} — no B2 images yet, skipping`);
      if (_io) _io.emit('ebay:bulk-desc:progress', { done, total, listingId, ok: false, skipped: true });
      return;
    }

    try {
      const token = await getAccessToken();

      // Generate fresh description HTML with current B2 image URLs
      const descRes = await axios.post(`${BASE}/api/ebay/generate-description`, {
        title: primary.title,
        specs: primary.specs || {},
        imageUrls,
        bullets: primary.bullets || [],
        upc: primary.upc,
        variant: primary.variant,
      });
      const html = descRes.data.html;
      if (!html) throw new Error('generate-description returned no HTML');

      // Push description to eBay
      const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
      const body = `<?xml version="1.0" encoding="utf-8"?><ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        ${creds}
        <Item>
          <ItemID>${escXml(listingId)}</ItemID>
          <Description><![CDATA[${html}]]></Description>
        </Item>
      </ReviseFixedPriceItemRequest>`;

      const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll', body, {
        headers: {
          'X-EBAY-API-SITEID': '0',
          'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
          'X-EBAY-API-IAF-TOKEN': token,
          'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem',
          'Content-Type': 'text/xml',
        },
      });

      const ok = !/<Ack>Failure<\/Ack>/.test(xml);
      if (!ok) {
        const msg = xml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1] || 'eBay error';
        throw new Error(msg);
      }

      done++; revised++;
      console.log(`bulk-revise-descriptions [${done}/${total}] ${listingId} ✓ (${imageUrls.length} B2 images)`);
      if (_io) _io.emit('ebay:bulk-desc:progress', { done, total, listingId, ok: true, title: primary.title });
    } catch (e) {
      done++; failed++;
      console.error(`bulk-revise-descriptions [${done}/${total}] ${listingId} ✗:`, e.message);
      if (_io) _io.emit('ebay:bulk-desc:progress', { done, total, listingId, ok: false, error: e.message });
    }
  })));

  console.log(`bulk-revise-descriptions done — ${revised} revised, ${failed} failed`);
  if (_io) _io.emit('ebay:bulk-desc:done', { total, revised, failed });
});

// Manual restock trigger — catches any sales missed by the cron window
router.post('/restock-now', async (req, res) => {
  try {
    const scheduler = require('../jobs/trackerScheduler');
    const lookbackMs = Math.min((parseInt(req.body.hours) || 3) * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
    await scheduler.autoRestock(lookbackMs);
    res.json({ ok: true, lookbackHours: lookbackMs / 3600000 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.setIo = setIo;
// Exposes the in-memory listing-views cache (id -> { count, expiresAt }) so other routes
// (e.g. tracker's "similar to what sells" search) can read current view counts without
// re-hitting the Analytics API themselves — best-effort, empty until the Tracker tab has
// loaded at least once and populated it via GET /api/ebay/listings/views.
module.exports.getViewsCache = () => viewsCache;
