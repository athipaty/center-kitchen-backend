const cron = require("node-cron");
const axios = require("axios");
const { fetchProduct } = require("../scraper");
const Product = require("../models/tracker/Product");
const { syncEbayPrice, syncEbayQty, endListing } = require("./ebayPriceSync");
const { deleteCloudinaryFolder } = require("../utils/cloudinaryUtils");

let io = null;

// Adaptive interval based on price stability:
// - Recently changed (last 3 days)  → 3–6h  (watch actively)
// - Unchanged 3–7 days              → 8–14h (moderate)
// - Unchanged 7+ days               → 20–28h (slow — saves ~4× ScraperAPI calls)
function adaptiveInterval(product) {
  const daysSinceChange = product.history?.length >= 2
    ? (Date.now() - new Date(product.history[product.history.length - 1].createdAt || 0)) / 86400000
    : 0;
  if (daysSinceChange >= 7)  return (Math.random() * 8  + 20) * 3600 * 1000; // 20–28h
  if (daysSinceChange >= 3)  return (Math.random() * 6  + 8)  * 3600 * 1000; // 8–14h
  return                            (Math.random() * 3  + 3)  * 3600 * 1000; // 3–6h
}

function nextCheckDate(product) {
  return new Date(Date.now() + adaptiveInterval(product));
}

function errorRetryDate() {
  // 30–90 min for transient errors (failCount < 3) — quick retry without hammering ScraperAPI
  return new Date(Date.now() + (Math.random() * 60 + 30) * 60 * 1000);
}

function slowRetryDate() {
  // 4–8h for persistent unavailable products (failCount >= 3) — saves ScraperAPI credits
  return new Date(Date.now() + (Math.random() * 4 + 4) * 3600 * 1000);
}

async function checkProduct(p) {
  try {
    // Use price-only direct fetch for routine checks — saves ScraperAPI credits.
    // Full scrape (priceOnly=false) only when metadata is missing or on first check.
    const needsFullScrape = !p.title || !p.image || !p.upc || (p.failCount || 0) > 0;
    const info = await fetchProduct(p.url, { priceOnly: !needsFullScrape });
    const oldPrice = p.current;
    const dropped = info.price < oldPrice;
    const previousStatus = p.status; // save before overwriting

    p.current = info.price;
    if (info.price < p.lowest) p.lowest = info.price;
    if (info.image  && !p.image)  p.image  = info.image;
    if (info.images?.length && (!p.images?.length)) p.images = info.images;
    if (info.upc    && !p.upc)    p.upc    = info.upc;
    if (info.isPrime !== null && info.isPrime !== undefined) p.isPrime = info.isPrime;
    if (info.variant) p.variant = info.variant;
    if (info.specs && Object.keys(info.specs).length) p.specs = info.specs;
    if (info.bullets?.length && !p.bullets?.length) p.bullets = info.bullets;
    if (info.price !== oldPrice) {
      p.history.push({ price: info.price });
      if (p.history.length > 200) p.history = p.history.slice(-200);
    }

    // Reset failure tracking on successful fetch
    p.status = 'active';
    p.failCount = 0;
    p.unavailableSince = null;

    if (p.ebayListingId) {
      try {
        await syncEbayPrice(p.ebayListingId, info.price, p.variant);
        // Restore qty if recovering from any non-active status
        if (previousStatus !== 'active') {
          await syncEbayQty(p.ebayListingId, p.variant, 3);
          console.log(`eBay qty restored: listing ${p.ebayListingId} variant="${p.variant}" → 3 (was ${previousStatus})`);
        }
        console.log(`eBay price synced: listing ${p.ebayListingId} variant="${p.variant}" → $${info.price}`);
        if (io) io.emit('tracker:ebay:sync:ok', { productId: String(p._id) });
      } catch (ebayErr) {
        console.error(`eBay price sync failed for listing ${p.ebayListingId}:`, ebayErr.message);
        if (io) io.emit('tracker:ebay:sync:fail', { productId: String(p._id), error: ebayErr.message });
      }
    }
    p.nextCheck = nextCheckDate(p);
    await p.save();

    if (dropped && io) {
      io.emit("tracker:price:drop", { product: p.toObject(), oldPrice });
    }

    return { id: p._id, success: true, dropped, newPrice: info.price, oldPrice };
  } catch (err) {
    p.failCount = (p.failCount || 0) + 1;

    if (err.code === 'OUT_OF_STOCK') {
      p.status = 'out_of_stock';
      p.nextCheck = p.failCount >= 3 ? slowRetryDate() : errorRetryDate();
    } else {
      p.status = p.failCount >= 3 ? 'unavailable' : 'error';
      p.nextCheck = p.failCount >= 3 ? slowRetryDate() : errorRetryDate();
    }
    // Track when product first became unavailable (for auto-end after 7 days)
    if (p.status === 'unavailable' && !p.unavailableSince) {
      p.unavailableSince = new Date();
    }

    // Push qty=0 to eBay so the variant shows as Out of Stock
    if (p.ebayListingId && (p.status === 'out_of_stock' || p.status === 'unavailable')) {
      try {
        await syncEbayQty(p.ebayListingId, p.variant, 0);
        console.log(`eBay qty set to 0: listing ${p.ebayListingId} variant="${p.variant}" (${p.status})`);
      } catch (qtyErr) {
        console.error(`eBay qty sync failed for listing ${p.ebayListingId}:`, qtyErr.message);
      }
    }

    if (io) io.emit('tracker:product:status', { productId: String(p._id), status: p.status, failCount: p.failCount });

    await p.save();
    return { id: p._id, success: false, status: p.status, failCount: p.failCount, error: err.message };
  }
}

const DEAD_LISTING_DAYS = 7;

async function checkDeadListings() {
  const cutoff = new Date(Date.now() - DEAD_LISTING_DAYS * 24 * 3600 * 1000);

  // Get all products with an eBay listing, check which are fully dead
  const listed = await Product.find({ ebayListingId: { $exists: true, $ne: null } }, 'ebayListingId status unavailableSince').lean();
  if (!listed.length) return;

  // Group by listingId — only end if ALL variants are unavailable for 7+ days
  const groups = {};
  for (const p of listed) {
    if (!groups[p.ebayListingId]) groups[p.ebayListingId] = [];
    groups[p.ebayListingId].push(p);
  }

  const deadIds = Object.entries(groups)
    .filter(([, variants]) =>
      variants.every(v => v.status === 'unavailable') &&
      variants.every(v => v.unavailableSince && new Date(v.unavailableSince) <= cutoff)
    )
    .map(([id]) => id);

  for (const listingId of deadIds) {
    try {
      await endListing(listingId);
      await Product.updateMany({ ebayListingId: listingId }, { $set: { ebayListingId: null } });
      console.log(`auto-ended dead listing: ${listingId} (all variants unavailable 7+ days)`);
      if (io) io.emit('tracker:listing:ended', { listingId });
    } catch (e) {
      console.error(`failed to end dead listing ${listingId}:`, e.message);
    }
  }
}

async function runDueChecks() {
  await checkDeadListings();
  const due = await Product.find({ nextCheck: { $lte: new Date() } });
  if (!due.length) return;

  if (io) io.emit("tracker:check:start", { count: due.length, time: new Date().toISOString() });

  const results = [];
  for (const p of due) {
    results.push(await checkProduct(p));
  }

  if (io) io.emit("tracker:check:done", { time: new Date().toISOString(), results });
}

async function runWeeklyOptimize() {
  const PORT = process.env.PORT || 5000;
  try {
    console.log('weekly-optimize: starting batch optimization of all listings…');
    const { data } = await axios.post(`http://localhost:${PORT}/api/ebay/batch-optimize`);
    console.log(`weekly-optimize: started — ${data.total} listings queued`);
  } catch (e) {
    console.error('weekly-optimize: failed to start:', e.message);
  }
}

// Auto-end listings that are 7+ days old with 0 eBay views
async function runAutoEndZeroViews() {
  try {
    const { getAccessToken } = require('./ebayPriceSync');
    const token = await getAccessToken();

    // Get all active listings with their start times
    const { data: listXml } = await axios.post('https://api.ebay.com/ws/api.dll',
      `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></ActiveList></GetMyeBaySellingRequest>`,
      { headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' } }
    );

    const sevenDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1000;
    const oldListings = [];
    const itemRe = /<Item>([\s\S]*?)<\/Item>/g;
    let m;
    while ((m = itemRe.exec(listXml)) !== null) {
      const block = m[1];
      const itemId = block.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];
      const startTime = block.match(/<StartTime>([\s\S]*?)<\/StartTime>/)?.[1];
      if (!itemId || !startTime) continue;
      if (new Date(startTime).getTime() <= sevenDaysAgo) {
        oldListings.push(itemId);
      }
    }

    console.log(`auto-end-zero-views: ${oldListings.length} listings are 7+ days old`);
    if (!oldListings.length) return;

    // Fetch view counts for old listings
    const now = new Date();
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const { data: viewsData } = await axios.get('https://api.ebay.com/sell/analytics/v1/traffic_report', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        dimension: 'LISTING',
        metric: 'LISTING_VIEWS_TOTAL',
        filter: `listing_ids:{${oldListings.join('|')}},date_range:[${fmt(start)}..${fmt(now)}]`,
      },
    });

    const viewCounts = {};
    for (const record of (viewsData.records || [])) {
      const lid = String(record.dimensionValues?.[0]?.value || '');
      if (lid) viewCounts[lid] = Number(record.metricValues?.[0]?.value ?? 0);
    }
    for (const id of oldListings) {
      if (viewCounts[id] == null) viewCounts[id] = 0;
    }

    // End listings with 0 views
    const toEnd = oldListings.filter(id => viewCounts[id] === 0);
    console.log(`auto-end-zero-views: ${toEnd.length} listings have 0 views → ending`);

    for (const listingId of toEnd) {
      try {
        await endListing(listingId);
        // Delete Cloudinary images for all products linked to this listing
        const linked = await Product.find({ ebayListingId: listingId });
        const folders = [...new Set(linked.map(p => p.cloudinaryFolder).filter(Boolean))];
        await Product.deleteMany({ ebayListingId: listingId });
        for (const folder of folders) {
          await deleteCloudinaryFolder(folder).catch(() => {});
        }
        console.log(`auto-end-zero-views: ended listing ${listingId}`);
      } catch (e) {
        console.error(`auto-end-zero-views: failed to end ${listingId}:`, e.message);
      }
    }
  } catch (e) {
    console.error('auto-end-zero-views: error:', e.message);
  }
}

// Auto-restock: after a sale, set qty back to 1 so listing stays live
async function runAutoRestock() {
  try {
    const { getAccessToken } = require('./ebayPriceSync');
    const token = await getAccessToken();

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

    // Get orders from the last 20 minutes (slightly overlapping 15min interval)
    const from = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const to   = new Date().toISOString();

    const { data: ordersXml } = await tradingPost('GetOrders',
      `<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<CreateTimeFrom>${from}</CreateTimeFrom><CreateTimeTo>${to}</CreateTimeTo><OrderStatus>Active</OrderStatus><DetailLevel>ReturnAll</DetailLevel></GetOrdersRequest>`
    );

    // Extract (ItemID, VariationSpecifics) pairs from all transactions
    const toRestock = []; // [{ itemId, variationSpecifics }]
    const orderBlocks = [...ordersXml.matchAll(/<Transaction>([\s\S]*?)<\/Transaction>/g)];
    for (const [, tx] of orderBlocks) {
      const itemId = tx.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];
      if (!itemId) continue;
      const varSpecs = tx.match(/<Variation>([\s\S]*?)<\/Variation>/)?.[1] || null;
      toRestock.push({ itemId, varSpecs });
    }

    if (!toRestock.length) return;
    console.log(`auto-restock: ${toRestock.length} sold item(s) to restock`);

    for (const { itemId, varSpecs } of toRestock) {
      try {
        if (varSpecs) {
          // Multi-variation: read all variations and set sold one back to 1
          const { data: getXml } = await tradingPost('GetItem',
            `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${itemId}</ItemID></GetItemRequest>`
          );
          const varBlocks = [...getXml.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)].map(m => m[0]);
          const soldSpecifics = varSpecs.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
          const soldValue = soldSpecifics.match(/<Value>([\s\S]*?)<\/Value>/)?.[1]?.toLowerCase() || '';

          const variationXml = varBlocks.map(vBlock => {
            const specs = vBlock.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
            const val = specs.match(/<Value>([\s\S]*?)<\/Value>/)?.[1]?.toLowerCase() || '';
            const price = vBlock.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1] || '0';
            const sku = vBlock.match(/<SKU>([\s\S]*?)<\/SKU>/)?.[1]?.trim();
            const skuXml = sku ? `<SKU>${sku}</SKU>` : '';
            const qty = (val === soldValue) ? 1 : (parseInt(vBlock.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] || '1'));
            return `<Variation>${skuXml}<StartPrice currencyID="USD">${parseFloat(price).toFixed(2)}</StartPrice><Quantity>${qty}</Quantity><VariationSpecifics>${specs}</VariationSpecifics></Variation>`;
          }).join('');

          await tradingPost('ReviseFixedPriceItem',
            `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${itemId}</ItemID><Variations>${variationXml}</Variations></Item></ReviseFixedPriceItemRequest>`
          );
        } else {
          // Single listing: set qty back to 1
          await tradingPost('ReviseInventoryStatus',
            `<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<InventoryStatus><ItemID>${itemId}</ItemID><Quantity>1</Quantity></InventoryStatus></ReviseInventoryStatusRequest>`
          );
        }
        console.log(`auto-restock: restocked listing ${itemId}`);
      } catch (e) {
        console.error(`auto-restock: failed to restock ${itemId}:`, e.message);
      }
    }
  } catch (e) {
    console.error('auto-restock: error:', e.message);
  }
}

function start(socketIo) {
  io = socketIo;
  // Check every 5 minutes which products are due
  cron.schedule("*/5 * * * *", runDueChecks);
  // Re-optimize all listings every Sunday at 3am
  cron.schedule("0 3 * * 0", runWeeklyOptimize);
  // Auto-end listings 7+ days old with 0 views — runs daily at 2am
  cron.schedule("0 2 * * *", runAutoEndZeroViews);
  // Auto-restock sold listings back to qty 1 — runs every 15 minutes
  cron.schedule("*/15 * * * *", runAutoRestock);
}

// Called when user clicks "Check Now" for a specific product or all products
async function triggerNow() {
  const products = await Product.find();
  if (!products.length) return;

  if (io) io.emit("tracker:check:start", { count: products.length, time: new Date().toISOString() });

  const results = [];
  for (const p of products) {
    results.push(await checkProduct(p));
  }

  if (io) io.emit("tracker:check:done", { time: new Date().toISOString(), results });
}

// Force-retry all products with status error/unavailable/out_of_stock immediately
async function retryErrors() {
  const result = await Product.updateMany(
    { status: { $in: ['error', 'unavailable', 'out_of_stock'] } },
    { $set: { nextCheck: new Date(), failCount: 0 } }
  );
  console.log(`retryErrors: reset ${result.modifiedCount} products for immediate recheck`);
  return result.modifiedCount;
}

// Set nextCheck on a newly added product
function scheduleNew(product) {
  product.nextCheck = nextCheckDate(product);
}

function getNextCheck() {
  return null; // now per-product, not global
}

module.exports = { start, triggerNow, checkOne: checkProduct, scheduleNew, getNextCheck, retryErrors, autoEndZeroViews: runAutoEndZeroViews, autoRestock: runAutoRestock };
