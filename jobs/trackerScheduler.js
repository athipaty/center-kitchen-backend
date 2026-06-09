const cron = require("node-cron");
const axios = require("axios");
const { fetchProduct } = require("../scraper");
const Product = require("../models/tracker/Product");
const { syncEbayPrice, syncEbayQty, endListing, calcEbayPrice } = require("./ebayPriceSync");
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

async function checkProduct(p, saleMode = false) {
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
    if (info.listPrice !== undefined) p.listPrice = info.listPrice;
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
      let syncErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await syncEbayPrice(p.ebayListingId, info.price, p.variant, saleMode);
          if (previousStatus !== 'active') {
            await syncEbayQty(p.ebayListingId, p.variant, 1);
            console.log(`eBay qty restored: listing ${p.ebayListingId} variant="${p.variant}" → 1 (was ${previousStatus})`);
          }
          const expected = calcEbayPrice(info.price, saleMode);
          console.log(`eBay price synced: listing ${p.ebayListingId} variant="${p.variant}" amazon=$${info.price} → ebay=$${expected}`);
          syncErr = null;
          break;
        } catch (e) {
          syncErr = e;
          if (attempt < 2) {
            console.warn(`eBay sync attempt ${attempt} failed for ${p.ebayListingId}: ${e.message} — retrying in 8s`);
            await new Promise(r => setTimeout(r, 8000));
          }
        }
      }
      if (syncErr) {
        console.error(`eBay price sync failed for listing ${p.ebayListingId} after 2 attempts:`, syncErr.message);
        if (io) io.emit('tracker:ebay:sync:fail', { productId: String(p._id), error: syncErr.message });
      } else {
        if (io) io.emit('tracker:ebay:sync:ok', { productId: String(p._id) });
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

    // Deliberately NOT pushing qty=0 to eBay here: ReviseFixedPriceItem silently deletes any
    // <Variation> whose quantity is 0 (eBay returns "Variations with quantity '0' will be
    // removed"), permanently dropping the variant from the listing rather than marking it OOS.
    // That's how listing 358647894021 lost its "Trap Jaw" variation. We leave the live quantity
    // as-is; buildMissingVariationXml in ebayPriceSync.js re-adds any variant that's missing
    // once it becomes active again.

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

  const TrackerSettings = require('../models/tracker/TrackerSettings');
  const settings = await TrackerSettings.findById('tracker').lean().catch(() => null);
  const saleMode = settings?.saleModeActive ?? false;

  if (io) io.emit("tracker:check:start", { count: due.length, time: new Date().toISOString() });

  const results = [];
  for (const p of due) {
    results.push(await checkProduct(p, saleMode));
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

// Orphan cleanup: end any active eBay listings not linked to a tracker product
async function runOrphanCleanup() {
  try {
    const { getAccessToken } = require('./ebayPriceSync');
    const token = await getAccessToken();
    const tradingHeaders = {
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-IAF-TOKEN': token,
      'Content-Type': 'text/xml',
    };

    // Fetch ALL active eBay listings — paginate until no more
    const allEbayIds = [];
    for (let page = 1; page <= 10; page++) {
      const xml = `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ActiveList><Include>true</Include><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList></GetMyeBaySellingRequest>`;
      const { data: xmlResp } = await axios.post('https://api.ebay.com/ws/api.dll', xml, { headers: { ...tradingHeaders, 'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling' } });
      if (/<Ack>Failure<\/Ack>/.test(xmlResp)) break;
      const ids = [...xmlResp.matchAll(/<ItemID>(\d+)<\/ItemID>/g)].map(m => m[1]);
      allEbayIds.push(...ids);
      if (!/<HasMoreItems>true<\/HasMoreItems>/.test(xmlResp)) break;
    }

    if (!allEbayIds.length) return;

    // Get all tracked listing IDs from DB
    const tracked = await Product.distinct('ebayListingId', { ebayListingId: { $exists: true, $ne: null } });
    const trackedSet = new Set(tracked.map(String));

    const orphanIds = [...new Set(allEbayIds)].filter(id => !trackedSet.has(id));
    if (!orphanIds.length) {
      console.log('orphan-cleanup: no orphans found');
      return;
    }

    console.log(`orphan-cleanup: found ${orphanIds.length} orphan listing(s) → ending`);
    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
    let ended = 0;
    for (const id of orphanIds) {
      try {
        const body = `<?xml version="1.0" encoding="utf-8"?><EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${id}</ItemID><EndingReason>NotAvailable</EndingReason></EndFixedPriceItemRequest>`;
        const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll', body, { headers: { ...tradingHeaders, 'X-EBAY-API-CALL-NAME': 'EndFixedPriceItem' } });
        if (!/<Ack>Failure<\/Ack>/.test(xml)) {
          ended++;
          console.log(`orphan-cleanup: ended orphan listing ${id}`);
        }
      } catch (e) {
        console.error(`orphan-cleanup: failed to end ${id}:`, e.message);
      }
    }

    if (io) io.emit('tracker:orphan:cleanup', { found: orphanIds.length, ended });
    console.log(`orphan-cleanup: done — ended ${ended}/${orphanIds.length}`);
  } catch (e) {
    console.error('orphan-cleanup: error:', e.message);
  }
}

// Auto-end listings 4+ days old with 0 eBay views, then fill freed slots with new discoveries
async function runAutoEndZeroViews() {
  let slotsFreed = 0;
  try {
    const { getAccessToken } = require('./ebayPriceSync');
    const token = await getAccessToken();

    const { data: listXml } = await axios.post('https://api.ebay.com/ws/api.dll',
      `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></ActiveList></GetMyeBaySellingRequest>`,
      { headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' } }
    );

    const fourDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1000;
    const oldListings = [];
    const itemRe = /<Item>([\s\S]*?)<\/Item>/g;
    let m;
    while ((m = itemRe.exec(listXml)) !== null) {
      const block = m[1];
      const itemId = block.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];
      const startTime = block.match(/<StartTime>([\s\S]*?)<\/StartTime>/)?.[1];
      if (!itemId || !startTime) continue;
      if (new Date(startTime).getTime() <= fourDaysAgo) oldListings.push(itemId);
    }

    console.log(`auto-end-zero-views: ${oldListings.length} listings are 4+ days old`);
    if (!oldListings.length) return;

    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const { data: viewsData } = await axios.get('https://api.ebay.com/sell/analytics/v1/traffic_report', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        dimension: 'LISTING',
        metric: 'LISTING_VIEWS_TOTAL',
        filter: `listing_ids:{${oldListings.join('|')}},date_range:[${fmt(start)}..${fmt(yesterday)}]`,
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

    const toEnd = oldListings.filter(id => viewCounts[id] === 0);
    console.log(`auto-end-zero-views: ${toEnd.length} listings have 0 views → ending`);

    for (const listingId of toEnd) {
      try {
        await endListing(listingId);
        const linked = await Product.find({ ebayListingId: listingId });
        const folders = [...new Set(linked.map(p => p.cloudinaryFolder).filter(Boolean))];
        // Each variant that was linked = 1 freed slot
        slotsFreed += linked.length;
        await Product.deleteMany({ ebayListingId: listingId });
        for (const folder of folders) {
          await deleteCloudinaryFolder(folder).catch(() => {});
        }
        console.log(`auto-end-zero-views: ended listing ${listingId} (${linked.length} variant slot(s) freed)`);
      } catch (e) {
        console.error(`auto-end-zero-views: failed to end ${listingId}:`, e.message);
      }
    }
  } catch (e) {
    console.error('auto-end-zero-views: error:', e.message);
  }

  // Chain directly into discovery using the exact slots we just freed
  if (slotsFreed > 0) {
    console.log(`auto-end-zero-views: ${slotsFreed} slot(s) freed → triggering product discovery`);
    const { runProductDiscovery } = require('./productDiscovery');
    await runProductDiscovery(io, slotsFreed);
  }
}

// Safety net: pick up Prime products that never made it onto eBay — e.g. a
// scheduleGroupAutoList debounce timer lost to a server restart mid-wait.
// (productDiscovery also runs this, but only when listing slots get freed up,
// so groups can otherwise sit stuck indefinitely showing "Will auto-list when
// Prime confirmed" in the UI.)
async function runPendingAutoListRetry() {
  try {
    const { retryPendingGroups } = require('./autoList');
    await retryPendingGroups(io);
  } catch (e) {
    console.error('pending-auto-list-retry: error:', e.message);
  }
}

// Slot target — keep this many active eBay listings by auto-discovering + listing
// one new product per hour whenever the count falls below this threshold.
const SLOT_FILL_TARGET = 175;

async function runHourlySlotFill() {
  try {
    const { getUsedListingCount } = require('./autoList');
    const used = await getUsedListingCount();
    if (used == null) {
      console.log('hourly-slot-fill: could not read slot count, skipping');
      return;
    }
    if (used >= SLOT_FILL_TARGET) {
      console.log(`hourly-slot-fill: at target (${used}/${SLOT_FILL_TARGET}), skipping`);
      return;
    }
    const slotsAvailable = SLOT_FILL_TARGET - used;
    console.log(`hourly-slot-fill: ${used}/${SLOT_FILL_TARGET} active listings — discovering 1 product (up to ${slotsAvailable} variant slot(s) available)`);
    const { runProductDiscovery } = require('./productDiscovery');
    await runProductDiscovery(io, slotsAvailable, { maxProducts: 1 });
  } catch (e) {
    console.error('hourly-slot-fill: error:', e.message);
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
      `<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<CreateTimeFrom>${from}</CreateTimeFrom><CreateTimeTo>${to}</CreateTimeTo><OrderStatus>All</OrderStatus><DetailLevel>ReturnAll</DetailLevel></GetOrdersRequest>`
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
            const skuXml = `<SKU>${sku || (itemId + (val ? '-' + val.replace(/[^a-z0-9]/g, '') : '')).slice(0, 50)}</SKU>`;
            const qty = (val === soldValue) ? 1 : (parseInt(vBlock.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] || '1'));
            return `<Variation>${skuXml}<StartPrice currencyID="USD">${parseFloat(price).toFixed(2)}</StartPrice><Quantity>${qty}</Quantity><VariationSpecifics>${specs}</VariationSpecifics></Variation>`;
          }).join('');

          // Re-include the existing <Pictures> block (per-variant photo mapping) verbatim —
          // ReviseFixedPriceItem replaces the whole <Variations> container, and omitting
          // <Pictures> makes eBay fall back to its default photo-to-variant assignment,
          // scrambling carefully-fixed per-variant photos on every restock.
          const picturesXml = getXml.match(/<Variations>[\s\S]*?(<Pictures>[\s\S]*?<\/Pictures>)[\s\S]*?<\/Variations>/)?.[1] || '';

          await tradingPost('ReviseFixedPriceItem',
            `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${itemId}</ItemID><Variations>${variationXml}${picturesXml}</Variations></Item></ReviseFixedPriceItemRequest>`
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
  // Auto-end listings 4+ days old with 0 views → immediately chains into product discovery
  cron.schedule("0 2 * * *", runAutoEndZeroViews);
  // Auto-restock sold listings back to qty 1 — runs every 15 minutes
  cron.schedule("*/15 * * * *", runAutoRestock);
  // Pick up any Prime products stuck without an eBay listing — runs every 20 minutes
  cron.schedule("*/20 * * * *", runPendingAutoListRetry);
  // Also run once shortly after startup to catch anything stuck from the last session
  setTimeout(runPendingAutoListRetry, 60 * 1000);
  // Auto-fill slots: if active listings < 175, discover + list 1 new product per hour.
  // Runs at :30 (not :00) to avoid colliding with runAutoEndZeroViews at 2:00am which
  // also chains into runProductDiscovery.
  cron.schedule("30 * * * *", runHourlySlotFill);
  // Orphan cleanup every 6 hours — ends any active eBay listings not in the tracker
  cron.schedule("0 */6 * * *", runOrphanCleanup);
  // Also run once shortly after startup to catch anything from the last session
  setTimeout(runOrphanCleanup, 30 * 1000);
}

// Called when user clicks "Check Now" for a specific product or all products
async function triggerNow() {
  const products = await Product.find();
  if (!products.length) return;

  const TrackerSettings = require('../models/tracker/TrackerSettings');
  const settings = await TrackerSettings.findById('tracker').lean().catch(() => null);
  const saleMode = settings?.saleModeActive ?? false;

  if (io) io.emit("tracker:check:start", { count: products.length, time: new Date().toISOString() });

  const results = [];
  for (const p of products) {
    results.push(await checkProduct(p, saleMode));
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

module.exports = { start, triggerNow, checkOne: checkProduct, scheduleNew, getNextCheck, retryErrors, autoEndZeroViews: runAutoEndZeroViews, autoRestock: runAutoRestock, orphanCleanup: runOrphanCleanup };
