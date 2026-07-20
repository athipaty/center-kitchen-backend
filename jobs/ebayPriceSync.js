const axios = require('axios');
const EbayToken = require('../models/shared/EbayToken');
const Product = require('../models/tracker/Product');

// ── Pricing constants — must stay in sync with frontend src/utils/pricing.js ──
const EBAY_FEE_RATE  = 0.1325;
const EBAY_FEE_FIXED = 0.30;
const PROMO_RATE     = 0.05;
const MARGIN         = 0.09;
const AMAZON_TAX     = 0.085;

function calcEbayPrice(amazonPrice) {
  const cost = amazonPrice * (1 + AMAZON_TAX);
  return Math.floor((cost + EBAY_FEE_FIXED) / (1 - EBAY_FEE_RATE - PROMO_RATE - MARGIN)) + 0.99;
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
    // Only update the fields this module manages — never overwrite refresh_token_expires_at
    // which is set by the OAuth flow in routes/ebay.js and must survive price-sync token refreshes.
    await EbayToken.findByIdAndUpdate('ebay', {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at,
    }, { upsert: true, new: true });
  } catch {}
}

// In-flight refresh promise — coalesces concurrent callers so only one HTTP round-trip
// is made when many price syncs run simultaneously with an expired token.
let _refreshPromise = null;

async function getAccessToken() {
  if (!tokens.refresh_token) {
    try {
      const doc = await EbayToken.findById('ebay');
      if (doc) tokens = { access_token: doc.access_token, refresh_token: doc.refresh_token, expires_at: doc.expires_at };
    } catch {}
  }
  if (tokens.access_token && Date.now() < tokens.expires_at - 60000) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error('eBay not connected');
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
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
    } finally {
      _refreshPromise = null;
    }
  })();
  return _refreshPromise;
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

// A GetItem/Revise* failure whose error means the listing itself no longer exists on eBay
// (ended, deleted, or never existed) — as opposed to a transient failure (rate limit, bad
// token) worth retrying. Same detection pattern already used in routes/ebay.js for the
// orphan-listing/price-check routes: error code 17, or one of the "item's gone" phrasings
// eBay uses across different call types.
function isListingGoneError(xml) {
  if (!/<Ack>Failure<\/Ack>/.test(xml)) return false;
  const errCode = xml.match(/<ErrorCode>(\d+)<\/ErrorCode>/)?.[1];
  const longMsg = (xml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1] || '').toLowerCase();
  return errCode === '17' || longMsg.includes('no such') || longMsg.includes('invalid item') || longMsg.includes('not found for itemid') || longMsg.includes('item does not exist');
}

// Wraps a "listing gone" failure in a distinctly-coded error so callers (trackerScheduler's
// checkProduct/runAutoRestock) can tell "the listing died, stop retrying and clear the DB
// link" apart from a transient failure worth retrying.
function listingGoneErr(message) {
  const err = new Error(message);
  err.code = 'LISTING_GONE';
  return err;
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
  // Fetch current Amazon price so we can calculate the correct eBay price for re-added variants,
  // rather than inheriting a sibling's price which may be for a completely different size/style.
  const tracked = await Product.find({ ebayListingId: cleanId }, 'variant status current').lean();
  if (tracked.length <= varBlocks.length) return '';

  const liveLabels = varBlocks.map(b => decodeEntities(b.match(/<Value>([\s\S]*?)<\/Value>/i)?.[1] || '').toLowerCase().trim());
  // Only re-add variants that are currently 'active' — re-adding an out-of-stock/unavailable
  // variant would immediately fight the next OOS check (which can't safely zero it back out,
  // since eBay deletes zero-quantity variations rather than marking them OOS).
  const missing = tracked.filter(p => p.variant && p.status === 'active' && !liveLabels.includes(p.variant.toLowerCase().trim()));
  if (!missing.length) return '';

  const dimName = varBlocks[0].match(/<NameValueList>[\s\S]*?<Name>([\s\S]*?)<\/Name>/)?.[1] || 'Style';
  const siblingFallbackPrice = varBlocks[0].match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || '0.00';

  return missing.map(p => {
    const label = p.variant;
    // Use the variant's own current Amazon price to calculate the correct eBay price.
    // Fall back to the sibling's live price if current is missing (shouldn't happen in practice).
    const price = p.current ? calcEbayPrice(p.current).toFixed(2) : siblingFallbackPrice;
    const sku = `${cleanId}-${label.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 50);
    console.warn(`ebayPriceSync: re-adding variation "${label}" missing from live listing ${cleanId} (SKU ${sku}, price $${price})`);
    return `<Variation><SKU>${sku}</SKU><StartPrice currencyID="USD">${price}</StartPrice><Quantity>1</Quantity><VariationSpecifics><NameValueList><Name>${escXml(dimName)}</Name><Value>${escXml(label)}</Value></NameValueList></VariationSpecifics></Variation>`;
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
  if (getErr) throw isListingGoneError(getItemXml) ? listingGoneErr(getErr) : new Error(getErr);

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

async function syncEbayPrice(listingId, amazonPrice, variantLabel) {
  const token = await getAccessToken();
  const cleanId = String(listingId).trim().replace(/\D/g, '');
  const priceStr = calcEbayPrice(Number(amazonPrice)).toFixed(2);
  const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;

  // Always GetItem first — determines single vs. multi-variation from the live eBay
  // listing structure, not from DB record count. DB count is unreliable: a 4-variation
  // eBay listing can have only 1 DB record linked (the rest not yet assigned), causing
  // the DB-count shortcut to call ReviseInventoryStatus on a variation listing, which
  // corrupts it. GetItem is the authoritative source.
  const { data: getItemXml } = await tradingPost(token, 'GetItem',
    `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID></GetItemRequest>`
  );
  const getErr = checkFailure(getItemXml);
  if (getErr) throw isListingGoneError(getItemXml) ? listingGoneErr(getErr) : new Error(getErr);

  const varBlocks = [...getItemXml.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)].map(m => m[0]);

  if (varBlocks.length === 0) {
    // Single listing — ReviseInventoryStatus is fine
    const { data: reviseXml } = await tradingPost(token, 'ReviseInventoryStatus',
      `<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<InventoryStatus><ItemID>${cleanId}</ItemID><StartPrice currencyID="USD">${priceStr}</StartPrice></InventoryStatus></ReviseInventoryStatusRequest>`
    );
    const err = checkFailure(reviseXml);
    if (err) throw new Error(err);
  } else {
    // Multi-variation: look up every DB variant for this listing and price each eBay
    // variation independently using its own Amazon price.
    const dbVariants = await Product.find({ ebayListingId: cleanId }).lean();

    const variationXml = varBlocks.map(block => {
      const valueMatch = block.match(/<Value>([\s\S]*?)<\/Value>/i);
      const ebayLabel = valueMatch?.[1] || '';
      const currentPriceM = block.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/);
      const currentPrice = currentPriceM ? parseFloat(currentPriceM[1]).toFixed(2) : priceStr;

      let thisPrice = currentPrice;
      let dbMatch = null;
      if (dbVariants.length) {
        dbMatch = bestVariantMatch(dbVariants, ebayLabel);
        if (dbMatch?.current) {
          thisPrice = calcEbayPrice(dbMatch.current).toFixed(2);
        }
      } else {
        // No DB records found — fall back to single-price update for the triggering variant
        thisPrice = labelMatch(ebayLabel, variantLabel || '') ? priceStr : currentPrice;
      }

      const specificsContent = block.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
      const sku = block.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
      const skuXml = sku ? `<SKU>${sku}</SKU>` : '';
      console.log(`ebayPriceSync: ${cleanId} "${ebayLabel}" → $${thisPrice} (db match: "${dbMatch?.variant || '?'}" @ $${dbMatch?.current?.toFixed(2) || '?'} Amazon)`);
      return `<Variation>${skuXml}<StartPrice currencyID="USD">${thisPrice}</StartPrice><VariationSpecifics>${specificsContent}</VariationSpecifics></Variation>`;
    }).join('');

    // Ghost-variant detection: any DB product linked to this listing whose variant
    // label doesn't match any live eBay variation is a phantom — it shows "eBay ✓"
    // in the UI but price syncs silently do nothing for it.
    // Log a warning immediately; auto-clear ebayListingId once the variant goes unavailable.
    const liveLabels = varBlocks
      .map(b => decodeEntities(b.match(/<Value>([\s\S]*?)<\/Value>/i)?.[1] || '').toLowerCase().trim())
      .filter(Boolean);
    for (const dbv of dbVariants) {
      const dbl = (dbv.variant || '').toLowerCase().trim();
      if (!dbl) continue;
      const hasLiveMatch = liveLabels.some(el =>
        el === dbl || el.includes(dbl) || (dbl.includes(el) && el.length > 2)
      );
      if (!hasLiveMatch) {
        console.warn(`ebayPriceSync: ghost variant "${dbv.variant}" (${dbv._id}) has no matching variation in live listing ${cleanId}`);
        if (dbv.status === 'unavailable') {
          await Product.updateOne({ _id: dbv._id }, { $unset: { ebayListingId: 1 } });
          console.log(`ebayPriceSync: auto-cleared ebayListingId for unavailable ghost variant "${dbv.variant}" (${dbv._id})`);
        }
      }
    }

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

// Remove a single variation from a multi-variation listing.
// Called when a tracker variant is deleted but siblings remain.
async function removeVariation(listingId, variantLabel) {
  const token = await getAccessToken();
  const cleanId = String(listingId).trim().replace(/\D/g, '');
  const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
  const label = (variantLabel || '').toLowerCase().trim();
  if (!cleanId || !label) throw new Error('listingId and variantLabel are required');

  const { data: getItemXml } = await tradingPost(token, 'GetItem',
    `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID></GetItemRequest>`
  );
  const getErr = checkFailure(getItemXml);
  if (getErr) throw new Error(getErr);

  const varBlocks = [];
  const varRe = /<Variation>([\s\S]*?)<\/Variation>/g;
  let vm;
  while ((vm = varRe.exec(getItemXml)) !== null) varBlocks.push(vm[0]);
  if (!varBlocks.length) return; // no variations — nothing to remove

  const kept = varBlocks.filter(vBlock => {
    const nvRe = /<NameValueList>([\s\S]*?)<\/NameValueList>/g;
    let nv;
    while ((nv = nvRe.exec(vBlock)) !== null) {
      const raw = nv[1].match(/<Value>([\s\S]*?)<\/Value>/)?.[1] || '';
      if (labelMatch(raw, label)) return false;
    }
    return true;
  });

  if (kept.length === varBlocks.length) return; // variation not found — already gone
  if (kept.length === 0) return; // last variant — caller handles ending the listing

  const toDelete = varBlocks.filter(vBlock => !kept.includes(vBlock));

  const keptXml = kept.map(vBlock => {
    const price = vBlock.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || '0.00';
    const specificsContent = vBlock.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
    const sku = vBlock.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
    const varVal = vBlock.match(/<Value>([\s\S]*?)<\/Value>/)?.[1] || '';
    const skuXml = sku ? `<SKU>${escXml(sku)}</SKU>` : `<SKU>${escXml(`${cleanId}-${varVal}`.slice(0, 50))}</SKU>`;
    const qty = vBlock.match(/<Quantity>([\d]+)<\/Quantity>/)?.[1] || '1';
    return `<Variation>${skuXml}<StartPrice currencyID="USD">${parseFloat(price).toFixed(2)}</StartPrice><Quantity>${qty}</Quantity><VariationSpecifics>${specificsContent}</VariationSpecifics></Variation>`;
  }).join('');

  // eBay requires explicit <Delete>true</Delete> — omitting a variation is not enough to remove it.
  const deletedXml = toDelete.map(vBlock => {
    const specificsContent = vBlock.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
    const sku = vBlock.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
    const skuXml = sku ? `<SKU>${escXml(sku)}</SKU>` : '';
    return `<Variation>${skuXml}<VariationSpecifics>${specificsContent}</VariationSpecifics><Delete>true</Delete></Variation>`;
  }).join('');

  const picturesXml = extractVariationPictures(getItemXml);
  const { data: xml } = await tradingPost(token, 'ReviseFixedPriceItem',
    `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${cleanId}</ItemID><Variations>${keptXml}${deletedXml}${picturesXml}</Variations></Item></ReviseFixedPriceItemRequest>`
  );
  const err = checkFailure(xml);
  // Treat ended-listing errors as success — the listing is already gone, nothing to revise.
  if (err && /already been closed|not allowed to revise ended|listing has ended|does not exist/i.test(err)) return;
  if (err) throw new Error(err);
}

module.exports = { syncEbayPrice, syncEbayQty, endListing, removeVariation, getAccessToken, bestVariantMatch, calcEbayPrice, checkFailure, isListingGoneError };
