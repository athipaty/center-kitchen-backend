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

  let inventoryItems;

  function buildInventoryItem(block) {
    const sku = block.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1];
    if (sku) {
      return `<InventoryStatus><ItemID>${cleanId}</ItemID><SKU>${sku}</SKU><StartPrice currencyID="USD">${priceStr}</StartPrice></InventoryStatus>`;
    }
    const specifics = block.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
    const specificsRevise = specifics ? `<VariationSpecificsRevise>${specifics}</VariationSpecificsRevise>` : '';
    return `<InventoryStatus><ItemID>${cleanId}</ItemID><StartPrice currencyID="USD">${priceStr}</StartPrice>${specificsRevise}</InventoryStatus>`;
  }

  if (varBlocks.length === 0) {
    // Single listing — straightforward update
    inventoryItems = [`<InventoryStatus><ItemID>${cleanId}</ItemID><StartPrice currencyID="USD">${priceStr}</StartPrice></InventoryStatus>`];
  } else if (variantLabel) {
    // Multi-variation: update only the matching color variation
    const label = variantLabel.toLowerCase();
    const matchedBlock = varBlocks.find(block => {
      const valueMatch = block.match(/<Value>([\s\S]*?)<\/Value>/i);
      return valueMatch && valueMatch[1].toLowerCase().includes(label);
    });

    if (matchedBlock) {
      inventoryItems = [buildInventoryItem(matchedBlock)];
    } else {
      // No match found — update all variations
      inventoryItems = varBlocks.map(buildInventoryItem);
    }
  } else {
    // No variant label — update all variations to same price
    inventoryItems = varBlocks.map(buildInventoryItem);
  }

  // Step 2: ReviseInventoryStatus (batched 4 at a time)
  for (let i = 0; i < inventoryItems.length; i += 4) {
    const batch = inventoryItems.slice(i, i + 4).join('');
    const { data: reviseXml } = await tradingPost(token, 'ReviseInventoryStatus',
      `<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}${batch}</ReviseInventoryStatusRequest>`
    );
    const err = checkFailure(reviseXml);
    if (err) throw new Error(err);
  }
}

module.exports = { syncEbayPrice };
