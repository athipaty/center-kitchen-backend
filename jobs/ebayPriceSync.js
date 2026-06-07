const axios = require('axios');
const EbayToken = require('../models/shared/EbayToken');
const Product = require('../models/tracker/Product');

// ── Pricing constants — must stay in sync with frontend src/utils/pricing.js ──
const EBAY_FEE_RATE  = 0.1325;
const EBAY_FEE_FIXED = 0.30;
const MIN_PROFIT     = 4.50;
const PROMO_RATE     = 0.05;
const SALE_MARGIN    = 0.02;
const AMAZON_TAX     = 0.085;

function calcEbayPrice(amazonPrice, saleMode = false) {
  const cost = amazonPrice * (1 + AMAZON_TAX);
  if (saleMode) {
    const price = (cost + EBAY_FEE_FIXED) / (1 - EBAY_FEE_RATE - PROMO_RATE - SALE_MARGIN);
    return Math.floor(price) + 0.99;
  }
  let multiplier;
  if (cost < 10)      multiplier = 2.2;
  else if (cost < 20) multiplier = 1.7;
  else if (cost < 35) multiplier = 1.55;
  else if (cost < 60) multiplier = 1.45;
  else                multiplier = 1.35;
  const tieredPrice = cost * multiplier;
  const minPrice    = (cost + MIN_PROFIT + EBAY_FEE_FIXED) / (1 - EBAY_FEE_RATE);
  return Math.floor(Math.max(tieredPrice, minPrice)) + 0.99;
}

let tokens = { access_token: null, refresh_token: null, expires_at: 0 };

(async () => {
  try {
    const doc = await EbayToken.findById('ebay');
    if (doc) tokens = { access_token: doc.access_token, refresh_token: doc.refresh_token, expires_at: doc.expires_at };
  } catch {}
})();

function basicAuth() {
  return Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');
}

async function saveTokens() {
  try {
    await EbayToken.findByIdAndUpdate('ebay', tokens, { upsert: true, new: true });
  } catch {}
}

async function getAccessToken() {
  if (!tokens.refresh_token) {
    try {
      const doc = await EbayToken.findById('ebay');
      if (doc) tokens = { access_token: doc.access_token, refresh_token: doc.refresh_token, expires_at: doc.expires_at };
    } catch {}
  }
  if (tokens.access_token && Date.now() < tokens.expires_at - 60000) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error('eBay not connected');
  const { data } = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
    { headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  tokens.access_token = data.access_token;
  tokens.expires_at = Date.now() + data.expires_in * 1000;
  await saveTokens();
  return tokens.access_token;
}

function tradingPost(token, callName, body) {
  return axios.post('https://api.ebay.com/ws/api.dll',
    `<?xml version="1.0" encoding="utf-8"?>${body}`,
    {
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml',
      },
    }
  );
}

function checkFailure(xml) {
  if (!/<Ack>Failure<\/Ack>/.test(xml)) return null;
  return xml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1] || 'eBay error';
}

function decodeEntities(str) {
  return (str || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function labelMatch(blockVal, label) {
  const v = decodeEntities(blockVal).toLowerCase().trim();
  const l = (label || '').toLowerCase().trim();
  return v === l || v.includes(l) || l.includes(v);
}

// Returns the DB variant that best matches an eBay variation label.
// Prefers exact match, then most-specific partial match (shortest DB name that still contains the eBay value).
function bestVariantMatch(variants, ebayVal) {
  const v = decodeEntities(ebayVal).toLowerCase().trim();
  // 1. Exact match
  const exact = variants.find(dbv => (dbv.variant || '').toLowerCase().trim() === v);
  if (exact) return exact;
  // 2. eBay value is contained in DB name (e.g. eBay="yellow", DB="2pcs yellow") — pick shortest DB name to avoid over-matching
  const supersets = variants.filter(dbv => (dbv.variant || '').toLowerCase().trim().includes(v));
  if (supersets.length) return supersets.reduce((a, b) => a.variant.length <= b.variant.length ? a : b);
  // 3. DB name is contained in eBay value — pick longest DB name (most specific)
  const subsets = variants.filter(dbv => v.includes((dbv.variant || '').toLowerCase().trim()));
  if (subsets.length) return subsets.reduce((a, b) => a.variant.length >= b.variant.length ? a : b);
  return variants[0];
}

function escXml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Extract the <Pictures> block (per-variant photo mapping) from a GetItem response so it
// can be re-included verbatim in ReviseFixedPriceItem requests. ReviseFixedPriceItem replaces
// the entire <Variations> container — omitting <Pictures> makes eBay fall back to its default
// photo-to-variant assignment, scrambling carefully-fixed per-variant photos.
function extractVariationPictures(getItemXml) {
  return getItemXml.match(/<Variations>[\s\S]*?(<Pictures>[\s\S]*?<\/Pictures>)[\s\S]*?<\/Variations>/)?.[1] || '';
}

// Self-heal: if the tracker has more variants for this listing than eBay currently shows,
// rebuild <Variation> entries for the missing ones (matching a sibling's live price/SKU
// convention) so the next ReviseFixedPriceItem re-adds them instead of leaving the listing
// permanently short a variant — this is how listing 358647894021 lost its "Trap Jaw" variant.
async function buildMissingVariationXml(cleanId, varBlocks) {
  if (!varBlocks.length) return '';
  const tracked = await Product.find({ ebayListingId: cleanId }, 'variant').lean();
  if (tracked.length <= varBlocks.length) return '';

  const liveLabels = varBlocks.map(b => decodeEntities(b.match(/<Value>([\s\S]*?)<\/Value>/i)?.[1] || '').toLowerCase().trim());
  const missing = tracked.filter(p => p.variant && !liveLabels.includes(p.variant.toLowerCase().trim()));
  if (!missing.length) return '';

  const dimName = varBlocks[0].match(/<NameValueList>[\s\S]*?<Name>([\s\S]*?)<\/Name>/)?.[1] || 'Style';
  // Match a sibling's current live price so the re-added variation lines up with the rest of the listing
  const fallbackPrice = varBlocks[0].match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || '0.00';

  return missing.map(p => {
    const label = p.variant;
    const sku = `${cleanId}-${label.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 50);
    console.warn(`ebayPriceSync: re-adding variation "${label}" missing from live listing ${cleanId} (SKU ${sku}, price $${fallbackPrice})`);
    return `<Variation><SKU>${sku}</SKU><StartPrice currencyID="USD">${fallbackPrice}</StartPrice><Quantity>1</Quantity><VariationSpecifics><NameValueList><Name>${escXml(dimName)}</Name><Value>${escXml(label)}</Value></NameValueList></VariationSpecifics></Variation>`;
  }).join('');
}

// Set eBay variation quantity to 0 (OOS) or back to qty (in-stock)
async function syncEbayQty(listingId, variantLabel, qty) {
  const token = await getAccessToken();
  const cleanId = String(listingId).trim().replace(/\D/g, '');
  const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

  const { data: getItemXml } = await tradingPost(token, 'GetItem',
    `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID></GetItemRequest>`
  );
  const getErr = checkFailure(getItemXml);
  if (getErr) throw new Error(getErr);

  const varBlocks = [...getItemXml.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)].map(m => m[0]);
  if (varBlocks.length === 0) return; // single listing — qty not applicable here

  const label = (variantLabel && variantLabel !== 'null') ? variantLabel.toLowerCase() : '';
  const variationXml = varBlocks.map(block => {
    const currentPriceM = block.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/);
    const currentPrice = currentPriceM ? parseFloat(currentPriceM[1]).toFixed(2) : '0.00';
    const currentQtyM  = block.match(/<Quantity>([\d]+)<\/Quantity>/);
    const currentQty   = currentQtyM ? currentQtyM[1] : '1';

    const valueMatch = block.match(/<Value>([\s\S]*?)<\/Value>/i);
    const varVal = valueMatch?.[1] || '';
    // No label = update all variations; with label = match only the target variant
    const isMatch = !label || labelMatch(varVal, label);

    const thisQty = isMatch ? String(qty) : currentQty;
    const specificsContent = block.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
    const sku = block.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
    const skuXml = `<SKU>${sku || (cleanId + (varVal ? '-' + varVal.replace(/[^a-z0-9]/gi,'').slice(0,20) : '')).slice(0,50)}</SKU>`;
    return `<Variation>${skuXml}<StartPrice currencyID="USD">${currentPrice}</StartPrice><Quantity>${thisQty}</Quantity><VariationSpecifics>${specificsContent}</VariationSpecifics></Variation>`;
  }).join('');

  const missingXml = await buildMissingVariationXml(cleanId, varBlocks).catch(() => '');
  const picturesXml = extractVariationPictures(getItemXml);

  const { data: reviseXml } = await tradingPost(token, 'ReviseFixedPriceItem',
    `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${cleanId}</ItemID><Variations>${variationXml}${missingXml}${picturesXml}</Variations></Item></ReviseFixedPriceItemRequest>`
  );
  const err = checkFailure(reviseXml);
  if (err) throw new Error(err);
}

// variantLabel — the color/variant name from Amazon (e.g. "purple"), used to match the right eBay variation
// saleMode — when true, uses sale pricing formula (currently same margin; ready for future differentiation)
async function syncEbayPrice(listingId, amazonPrice, variantLabel, saleMode = false) {
  const token = await getAccessToken();
  const cleanId = String(listingId).trim().replace(/\D/g, '');
  const ebayPrice = calcEbayPrice(Number(amazonPrice), saleMode);
  const priceStr = ebayPrice.toFixed(2);
  const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

  // Step 1: GetItem to check if this is a multi-variation listing
  const { data: getItemXml } = await tradingPost(token, 'GetItem',
    `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID></GetItemRequest>`
  );
  const getErr = checkFailure(getItemXml);
  if (getErr) throw new Error(getErr);

  const varBlocks = [...getItemXml.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)].map(m => m[0]);

  if (varBlocks.length === 0) {
    // Single listing — ReviseInventoryStatus is fine
    const { data: reviseXml } = await tradingPost(token, 'ReviseInventoryStatus',
      `<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<InventoryStatus><ItemID>${cleanId}</ItemID><StartPrice currencyID="USD">${priceStr}</StartPrice></InventoryStatus></ReviseInventoryStatusRequest>`
    );
    const err = checkFailure(reviseXml);
    if (err) throw new Error(err);
  } else {
    // Multi-variation — use ReviseFixedPriceItem (works for both SKU-based and non-SKU listings)
    const label = (variantLabel || '').toLowerCase();
    const variationXml = varBlocks.map(block => {
      const currentPriceM = block.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/);
      const currentPrice = currentPriceM ? parseFloat(currentPriceM[1]).toFixed(2) : priceStr;

      let isMatch = !label;
      if (label) {
        const valueMatch = block.match(/<Value>([\s\S]*?)<\/Value>/i);
        isMatch = labelMatch(valueMatch?.[1] || '', label);
      }

      const thisPrice = isMatch ? priceStr : currentPrice;
      const specificsContent = block.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
      const sku = block.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
      const skuXml = sku ? `<SKU>${sku}</SKU>` : '';
      return `<Variation>${skuXml}<StartPrice currencyID="USD">${thisPrice}</StartPrice><VariationSpecifics>${specificsContent}</VariationSpecifics></Variation>`;
    }).join('');

    const missingXml = await buildMissingVariationXml(cleanId, varBlocks).catch(() => '');
    const picturesXml = extractVariationPictures(getItemXml);

    const { data: reviseXml } = await tradingPost(token, 'ReviseFixedPriceItem',
      `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${cleanId}</ItemID><Variations>${variationXml}${missingXml}${picturesXml}</Variations></Item></ReviseFixedPriceItemRequest>`
    );
    const err = checkFailure(reviseXml);
    if (err) throw new Error(err);
  }
}

// End a listing permanently (e.g. product no longer available)
async function endListing(listingId) {
  const token = await getAccessToken();
  const cleanId = String(listingId).trim().replace(/\D/g, '');
  const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
  const { data: xml } = await tradingPost(token, 'EndFixedPriceItem',
    `<EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID><EndingReason>NotAvailable</EndingReason></EndFixedPriceItemRequest>`
  );
  const err = checkFailure(xml);
  if (err) throw new Error(err);
}

module.exports = { syncEbayPrice, syncEbayQty, endListing, getAccessToken, bestVariantMatch, calcEbayPrice };
