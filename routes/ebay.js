const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

async function getAccessToken() {
  if (tokens.access_token && Date.now() < tokens.expires_at - 60000) return tokens.access_token;
  if (!tokens.refresh_token) {
    const err = new Error('not_authenticated');
    err.status = 401;
    throw err;
  }
  const { data } = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
    { headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  tokens.access_token = data.access_token;
  tokens.expires_at = Date.now() + data.expires_in * 1000;
  saveTokens();
  return tokens.access_token;
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
  const scope = 'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly';
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

    const { data: offersData } = await axios.get('https://api.ebay.com/sell/inventory/v1/offer', {
      headers: { Authorization: `Bearer ${token}` },
      params: { status: 'PUBLISHED', limit: 100 },
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
    res.status(500).json({ error: ebayError(err) });
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
