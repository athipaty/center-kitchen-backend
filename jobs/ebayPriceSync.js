const axios = require('axios');
const EbayToken = require('../models/shared/EbayToken');

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

// variantLabel — the color/variant name from Amazon (e.g. "purple"), used to match the right eBay variation
async function syncEbayPrice(listingId, amazonPrice, variantLabel) {
  const token = await getAccessToken();
  const cleanId = String(listingId).trim().replace(/\D/g, '');
  const ebayPrice = Math.floor(Number(amazonPrice) * 1.45) + 0.99;
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
        const val = (valueMatch?.[1] || '').toLowerCase();
        isMatch = val === label || label.includes(val) || val.includes(label);
      }

      const thisPrice = isMatch ? priceStr : currentPrice;
      const specificsContent = block.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
      const sku = block.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
      const skuXml = sku ? `<SKU>${sku}</SKU>` : '';
      return `<Variation>${skuXml}<StartPrice currencyID="USD">${thisPrice}</StartPrice><VariationSpecifics>${specificsContent}</VariationSpecifics></Variation>`;
    }).join('');

    const { data: reviseXml } = await tradingPost(token, 'ReviseFixedPriceItem',
      `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${cleanId}</ItemID><Variations>${variationXml}</Variations></Item></ReviseFixedPriceItemRequest>`
    );
    const err = checkFailure(reviseXml);
    if (err) throw new Error(err);
  }
}

module.exports = { syncEbayPrice };
