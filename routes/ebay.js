const express = require('express');
const router = express.Router();
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const EbayToken = require('../models/shared/EbayToken');

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
let tokens = { access_token: null, refresh_token: null, expires_at: 0 };

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
      if (doc) tokens = { access_token: doc.access_token, refresh_token: doc.refresh_token, expires_at: doc.expires_at };
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
  ].join(' ');
  const url = `https://auth.ebay.com/oauth2/authorize?client_id=${encodeURIComponent(process.env.EBAY_APP_ID)}&redirect_uri=${encodeURIComponent(process.env.EBAY_RUNAME)}&response_type=code&scope=${encodeURIComponent(scope)}`;
  res.redirect(url);
});

router.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No authorization code received from eBay.');
  try {
    const { data } = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.EBAY_RUNAME }),
      { headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
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
      if (doc) tokens = { access_token: doc.access_token, refresh_token: doc.refresh_token, expires_at: doc.expires_at };
    } catch {}
  }
  res.json({ connected: !!tokens.refresh_token });
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
    const { data: offersData } = await axios.get('https://api.ebay.com/sell/inventory/v1/offer', {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit: 100 },
    });

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
        step = 'publish retry stripped';
        const strippedTitle = safeTitle.replace(/\s+-\s+\S.*$/, '').trim();
        console.log(`create-listing: 25019 stripped retry title="${strippedTitle}" cat=${resolvedCategory || 'none'}`);
        try {
          // Re-PUT inventory item with cleaned content
          await axios.put(
            `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(safeSKU)}`,
            {
              condition,
              product: {
                title: strippedTitle,
                description: 'See photos and title for complete item details.',
                aspects: {},
                ...(proxyUrls.length ? { imageUrls: proxyUrls } : {}),
              },
              availability: { shipToLocationAvailability: { quantity: Number(quantity) } },
            },
            { headers: h }
          );
          // If no leaf category was detected earlier, look one up from the stripped title
          if (!resolvedCategory) {
            resolvedCategory = await lookupCategory(strippedTitle, upc);
            if (resolvedCategory) {
              offerPayload.categoryId = resolvedCategory;
              const { sku: _s, marketplaceId: _m, format: _f, ...uf } = offerPayload;
              await axios.put(`https://api.ebay.com/sell/inventory/v1/offer/${offerData.offerId}`, uf, { headers: h });
            }
          }
          ({ data: published } = await axios.post(
            `https://api.ebay.com/sell/inventory/v1/offer/${offerData.offerId}/publish`,
            {}, { headers: h }
          ));
        } catch (strippedErr) {
          console.log('create-listing: stripped retry failed:', strippedErr.response?.data?.errors?.[0]?.longMessage || strippedErr.message);
          throw pubErr;
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

// ── SEO title generation ───────────────────────────────────────────
router.post('/seo-title', async (req, res) => {
  const { title, specs } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const specLines = specs
      ? Object.entries(specs)
          .filter(([k, v]) => v && !['asin', 'best_sellers_rank', 'customer_reviews'].includes(k))
          .slice(0, 12)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('; ')
      : '';

    const prompt = `Generate an SEO-optimized eBay listing title for this product.

Amazon title: ${title}${specLines ? `\nKey specs: ${specLines}` : ''}

Rules:
- MUST be 75 characters or less — never exceed this, titles that run long get cut off
- Must end on a complete word — never cut mid-word or mid-phrase
- Include brand name and model number if present
- Use keywords buyers search for (key feature, quantity, color/size if relevant)
- Title Case
- No "100%", no asterisks, no "best", no exclamation marks
- Output ONLY the title, no quotes, no explanation`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    });

    let generated = (message.content[0]?.text || '').trim().replace(/^["']|["']$/g, '');
    // If still over 80, trim to last complete word before the limit
    if (generated.length > 80) {
      generated = generated.slice(0, 80).replace(/\s+\S*$/, '').trimEnd();
    }

    res.json({ title: generated || title.slice(0, 80) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sold listings (profit research) ───────────────────────────────
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

module.exports = router;
