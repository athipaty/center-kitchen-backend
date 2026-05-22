const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// ── Sold-price cache (6h TTL) ──────────────────────────────────────
const soldCache = new Map(); // key → { data, expiresAt }
const SOLD_TTL = 6 * 60 * 60 * 1000;

function getCached(key) {
  const entry = soldCache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.data;
  soldCache.delete(key);
  return null;
}
function setCache(key, data) {
  soldCache.set(key, { data, expiresAt: Date.now() + SOLD_TTL });
}

// ── Token persistence ──────────────────────────────────────────────
const TOKEN_FILE = path.join(__dirname, '..', 'ebay_tokens.json');
let tokens = { access_token: null, refresh_token: null, expires_at: 0 };
try { tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch {}

function saveTokens() {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens)); } catch {}
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
    saveTokens();
    return tokens.access_token;
  } catch {
    // Refresh token is expired or revoked — force re-authentication
    tokens = { access_token: null, refresh_token: null, expires_at: 0 };
    saveTokens();
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
    saveTokens();
    res.redirect(`${process.env.CLIENT_URL}/ebay?connected=1`);
  } catch (err) {
    res.status(500).send('eBay auth failed: ' + (err.response?.data?.error_description || err.message));
  }
});

router.get('/auth/status', (_req, res) => {
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

function buildDescription(title, specs) {
  if (!specs || !Object.keys(specs).length) return `<p>${title}</p>`;
  const rows = Object.entries(specs)
    .filter(([k, v]) => v && !['asin', 'best_sellers_rank', 'customer_reviews'].includes(k))
    .map(([k, v]) => {
      const label = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const display = Array.isArray(v) ? v.join(', ') : (typeof v === 'object' ? JSON.stringify(v) : v);
      return `<li><b>${label}:</b> ${display}</li>`;
    });
  return `<h2>${title}</h2><ul>${rows.join('')}</ul>`;
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
  try {
    const token = await getAccessToken();
    const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Language': 'en-US' };

    const {
      sku, title, price, currency = 'USD', quantity = 1,
      condition = 'NEW', categoryId,
      imageUrl, upc, specs = {},
      shipping = { free: true, carrier: 'USPSFirstClass', handlingDays: 1 },
      returns = { accepted: true, days: 30, buyerPays: true },
      zipCode = '10001',
    } = req.body;

    if (!sku || !title || !price) {
      return res.status(400).json({ error: 'Missing required fields: sku, title, price' });
    }

    const safeTitle = title.slice(0, 80);
    const safeSKU = sanitizeSku(sku);
    console.log(`create-listing: raw sku="${sku}" → safeSKU="${safeSKU}"`);

    step = 'resolving policies';
    const { fulfillmentPolicyId, returnPolicyId, paymentPolicyId, merchantLocationKey } =
      await resolveListingPolicies(token, { shipping, returns, zipCode });

    step = 'creating inventory item';
    // imageUrl is omitted — Amazon CDN blocks eBay's image fetcher and causes a server error
    const inventoryProduct = {
      title: safeTitle,
      description: buildDescription(safeTitle, specs),
      aspects: buildAspects(specs),
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
    if (categoryId) offerPayload.categoryId = String(categoryId);

    let offerData;
    try {
      ({ data: offerData } = await axios.post('https://api.ebay.com/sell/inventory/v1/offer', offerPayload, { headers: h }));
    } catch (offerErr) {
      const errs = offerErr.response?.data?.errors || [];
      const isExistsErr = errs.some(e => /already exists/i.test(String(e.longMessage || e.message || '')));
      const isCatErr = errs.some(e => /categoryid|category/i.test(String(e.longMessage || e.message || '')));

      if (isExistsErr) {
        // A draft offer already exists for this SKU — update it with current data then publish
        const { data: listData } = await axios.get(
          'https://api.ebay.com/sell/inventory/v1/offer',
          { headers: h, params: { sku: safeSKU } }
        );
        const existing = (listData.offers || [])[0];
        if (!existing) throw offerErr;
        const { sku: _s, marketplaceId: _m, format: _f, ...updateFields } = offerPayload;
        await axios.put(
          `https://api.ebay.com/sell/inventory/v1/offer/${existing.offerId}`,
          updateFields, { headers: h }
        );
        offerData = existing;
      } else if (isCatErr && offerPayload.categoryId) {
        // Suggested category rejected — retry without and let eBay auto-determine
        console.log(`create-listing: categoryId "${offerPayload.categoryId}" rejected, retrying without`);
        delete offerPayload.categoryId;
        ({ data: offerData } = await axios.post('https://api.ebay.com/sell/inventory/v1/offer', offerPayload, { headers: h }));
      } else {
        throw offerErr;
      }
    }

    step = 'publishing offer';
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
      ? ebayErrs.map(e => String(e.longMessage || e.message || '')).join(' | ')
      : String(err.message || 'Unknown error');
    console.error(`create-listing [${step}] error:`, JSON.stringify(err.response?.data ?? err.message));
    res.status(500).json({ error: `[${step}] ${detail}` });
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

    const safeTitle = title.slice(0, 80);
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
            description: buildDescription(safeTitle, specs),
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
        description: buildDescription(safeTitle, specs),
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

    // 3. Create offer for the group
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
    if (categoryId) offerPayload.categoryId = String(categoryId);

    const { data: offerData } = await axios.post('https://api.ebay.com/sell/inventory/v1/offer', offerPayload, { headers: h });

    // 4. Publish
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

  // Primary: search real eBay listings — category IDs from live items are always valid for selling
  if (process.env.EBAY_APP_ID) {
    try {
      const { data } = await axios.get('https://svcs.ebay.com/services/search/FindingService/v1', {
        params: {
          'OPERATION-NAME': 'findItemsByKeywords',
          'SERVICE-VERSION': '1.0.0',
          'SECURITY-APPNAME': process.env.EBAY_APP_ID,
          'RESPONSE-DATA-FORMAT': 'JSON',
          keywords: q,
          'paginationInput.entriesPerPage': 10,
          sortOrder: 'BestMatch',
        },
      });
      const items = data.findItemsByKeywordsResponse?.[0]?.searchResult?.[0]?.item || [];
      const seen = new Set();
      const suggestions = [];
      for (const item of items) {
        const catId = item.primaryCategory?.[0]?.categoryId?.[0];
        const catName = item.primaryCategory?.[0]?.categoryName?.[0] || '';
        if (catId && !seen.has(catId)) {
          seen.add(catId);
          suggestions.push({ id: catId, name: catName, path: catName });
        }
        if (suggestions.length >= 3) break;
      }
      if (suggestions.length > 0) return res.json(suggestions);
    } catch { /* fall through to taxonomy */ }
  }

  // Fallback: taxonomy API
  try {
    const token = await getAccessToken();
    const h = { Authorization: `Bearer ${token}` };
    let treeId = '0';
    try {
      const { data: treeData } = await axios.get(
        'https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id',
        { params: { marketplace_id: 'EBAY_US' }, headers: h }
      );
      treeId = String(treeData.categoryTreeId || '0');
    } catch {}
    const { data } = await axios.get(
      `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions`,
      { params: { q }, headers: h }
    );
    const suggestions = (data.categorySuggestions || []).slice(0, 3).map(s => {
      const ancestors = (s.categoryTreeNodeAncestors || [])
        .sort((a, b) => (a.categoryTreeNodeLevel || 0) - (b.categoryTreeNodeLevel || 0));
      const pathParts = [...ancestors.slice(-2).map(a => a.categoryName), s.category.categoryName];
      return { id: String(s.category.categoryId), name: s.category.categoryName, path: pathParts.join(' > ') };
    });
    return res.json(suggestions);
  } catch (err) {
    if (err.status === 401 || err.message === 'not_authenticated')
      return res.status(401).json({ error: 'not_authenticated' });
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
