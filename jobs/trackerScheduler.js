const cron = require("node-cron");
const axios = require("axios");
const { fetchProduct } = require("../scraper");
const Product = require("../models/tracker/Product");
const { syncEbayPrice, syncEbayQty, endListing, calcEbayPrice } = require("./ebayPriceSync");
const { deleteCloudinaryFolder } = require("../utils/cloudinaryUtils");

let io = null;

// Adaptive interval based on price stability:
// - Recently changed (last 3 days)  → 3–6h   (watch actively)
// - Unchanged 3–7 days              → 8–14h  (moderate)
// - Unchanged 7–14 days             → 36–48h (slow — saves ~6× ScraperAPI calls)
// - Unchanged 14+ days              → 48–72h (very slow — prices rarely move)
function adaptiveInterval(product) {
  // Use the last history entry's timestamp regardless of how many entries exist.
  // The old check (history.length >= 2) forced daysSinceChange=0 for products that
  // have never had a price change, causing them to be checked at 3–6h forever.
  const lastEntry = product.history?.[product.history.length - 1];
  const daysSinceChange = lastEntry?.createdAt
    ? (Date.now() - new Date(lastEntry.createdAt).getTime()) / 86400000
    : 0;
  if (daysSinceChange >= 14) return (Math.random() * 24 + 72) * 3600 * 1000; // 72–96h
  if (daysSinceChange >= 7)  return (Math.random() * 12 + 48) * 3600 * 1000; // 48–60h
  if (daysSinceChange >= 3)  return (Math.random() * 4  + 12) * 3600 * 1000; // 12–16h
  return                            (Math.random() * 4  + 6)  * 3600 * 1000; // 6–10h
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
    const needsFullScrape = !p.title || !p.image;
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
// Listings with views or watchers are skipped — they have buyer interest worth keeping.
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

    // Fetch ALL active eBay listings with watch counts — paginate until no more
    const allEbayIds = [];
    const watchCountMap = {}; // listingId → watchCount
    for (let page = 1; page <= 10; page++) {
      const xml = `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ActiveList><Include>true</Include><IncludeWatchCount>true</IncludeWatchCount><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList></GetMyeBaySellingRequest>`;
      const { data: xmlResp } = await axios.post('https://api.ebay.com/ws/api.dll', xml, { headers: { ...tradingHeaders, 'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling' } });
      if (/<Ack>Failure<\/Ack>/.test(xmlResp)) break;
      const itemRe = /<Item>([\s\S]*?)<\/Item>/g;
      let m;
      while ((m = itemRe.exec(xmlResp)) !== null) {
        const block = m[1];
        const itemId = block.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];
        if (!itemId) continue;
        allEbayIds.push(itemId);
        watchCountMap[itemId] = parseInt(block.match(/<WatchCount>(\d+)<\/WatchCount>/)?.[1] || '0', 10);
      }
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

    // Fetch view counts for orphans via Analytics API — skip any with views or watches
    let viewCounts = {};
    try {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
      const { data: viewsData } = await axios.get('https://api.ebay.com/sell/analytics/v1/traffic_report', {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          dimension: 'LISTING',
          metric: 'LISTING_VIEWS_TOTAL',
          filter: `listing_ids:{${orphanIds.join('|')}},date_range:[${fmt(start)}..${fmt(yesterday)}]`,
        },
      });
      for (const record of (viewsData.records || [])) {
        const lid = String(record.dimensionValues?.[0]?.value || '');
        if (lid) viewCounts[lid] = Number(record.metricValues?.[0]?.value ?? 0);
      }
    } catch (e) {
      console.warn('orphan-cleanup: could not fetch view counts:', e.message);
    }

    const toEnd = orphanIds.filter(id => (viewCounts[id] || 0) === 0 && (watchCountMap[id] || 0) === 0);
    const skipped = orphanIds.filter(id => (viewCounts[id] || 0) > 0 || (watchCountMap[id] || 0) > 0);
    if (skipped.length) {
      console.log(`orphan-cleanup: keeping ${skipped.length} orphan(s) with views/watches: ${skipped.map(id => `${id}(v:${viewCounts[id]||0},w:${watchCountMap[id]||0})`).join(', ')}`);
    }

    if (!toEnd.length) {
      console.log('orphan-cleanup: no orphans to end (all have views or watches)');
      return;
    }

    console.log(`orphan-cleanup: ending ${toEnd.length} orphan listing(s) with no engagement`);
    const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
    let ended = 0;
    for (const id of toEnd) {
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

    if (io) io.emit('tracker:orphan:cleanup', { found: orphanIds.length, ended, skipped: skipped.length });
    console.log(`orphan-cleanup: done — ended ${ended}/${toEnd.length} (${skipped.length} kept for views/watches)`);
  } catch (e) {
    console.error('orphan-cleanup: error:', e.message);
  }
}

// Auto-end listings 4+ days old with 0 eBay views AND 0 watchers, then fill freed slots
async function runAutoEndZeroViews() {
  try {
    const { getAccessToken } = require('./ebayPriceSync');
    const token = await getAccessToken();

    // Fetch active listings with watch counts in one call
    const { data: listXml } = await axios.post('https://api.ebay.com/ws/api.dll',
      `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ActiveList><Include>true</Include><IncludeWatchCount>true</IncludeWatchCount><Pagination><EntriesPerPage>200</EntriesPerPage></Pagination></ActiveList></GetMyeBaySellingRequest>`,
      { headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' } }
    );

    const fourDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1000;
    const oldListings = [];
    const watchCounts = {};
    const itemRe = /<Item>([\s\S]*?)<\/Item>/g;
    let m;
    while ((m = itemRe.exec(listXml)) !== null) {
      const block = m[1];
      const itemId = block.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];
      const startTime = block.match(/<StartTime>([\s\S]*?)<\/StartTime>/)?.[1];
      if (!itemId || !startTime) continue;
      watchCounts[itemId] = parseInt(block.match(/<WatchCount>(\d+)<\/WatchCount>/)?.[1] || '0', 10);
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

    // Only end listings with 0 views AND 0 watchers — keep anything with buyer interest
    const toEnd = oldListings.filter(id => viewCounts[id] === 0 && (watchCounts[id] || 0) === 0);
    const kept = oldListings.filter(id => viewCounts[id] > 0 || (watchCounts[id] || 0) > 0);
    if (kept.length) {
      console.log(`auto-end-zero-views: keeping ${kept.length} listing(s) with views/watches: ${kept.map(id => `${id}(v:${viewCounts[id]},w:${watchCounts[id]||0})`).join(', ')}`);
    }
    console.log(`auto-end-zero-views: ${toEnd.length} listings have 0 views and 0 watches → ending`);

    for (const listingId of toEnd) {
      try {
        await endListing(listingId);
        const linked = await Product.find({ ebayListingId: listingId });
        const folders = [...new Set(linked.map(p => p.cloudinaryFolder).filter(Boolean))];
        await Product.deleteMany({ ebayListingId: listingId });
        for (const folder of folders) {
          await deleteCloudinaryFolder(folder).catch(() => {});
        }
        console.log(`auto-end-zero-views: deleted listing ${listingId} (${linked.length} variant slot(s) freed)`);
      } catch (e) {
        console.error(`auto-end-zero-views: failed to end ${listingId}:`, e.message);
      }
    }
  } catch (e) {
    console.error('auto-end-zero-views: error:', e.message);
  }

}

// Relist any recently-ended (unsold) listings that have views or watchers.
// eBay's RelistFixedPriceItem creates a new listing with a new ID, preserving
// the item title, price, and description from the original.
async function runRelistUnsoldWithEngagement() {
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

    // Fetch unsold listings (ended in the last 60 days) with watch counts
    const unsoldIds = [];
    const watchCounts = {};
    for (let page = 1; page <= 5; page++) {
      const xml = `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<UnsoldList><Include>true</Include><IncludeWatchCount>true</IncludeWatchCount><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination><DurationInDays>60</DurationInDays></UnsoldList></GetMyeBaySellingRequest>`;
      const { data: xmlResp } = await axios.post('https://api.ebay.com/ws/api.dll', xml, { headers: { ...tradingHeaders, 'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling' } });
      if (/<Ack>Failure<\/Ack>/.test(xmlResp)) break;
      const itemRe = /<Item>([\s\S]*?)<\/Item>/g;
      let m;
      while ((m = itemRe.exec(xmlResp)) !== null) {
        const block = m[1];
        const itemId = block.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];
        if (!itemId) continue;
        unsoldIds.push(itemId);
        watchCounts[itemId] = parseInt(block.match(/<WatchCount>(\d+)<\/WatchCount>/)?.[1] || '0', 10);
      }
      if (!/<HasMoreItems>true<\/HasMoreItems>/.test(xmlResp)) break;
    }

    if (!unsoldIds.length) {
      console.log('relist-unsold: no unsold listings found');
      return;
    }

    // Fetch view counts from Analytics API for all unsold IDs
    const viewCounts = {};
    try {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
      const { data: viewsData } = await axios.get('https://api.ebay.com/sell/analytics/v1/traffic_report', {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          dimension: 'LISTING',
          metric: 'LISTING_VIEWS_TOTAL',
          filter: `listing_ids:{${unsoldIds.join('|')}},date_range:[${fmt(start)}..${fmt(yesterday)}]`,
        },
      });
      for (const record of (viewsData.records || [])) {
        const lid = String(record.dimensionValues?.[0]?.value || '');
        if (lid) viewCounts[lid] = Number(record.metricValues?.[0]?.value ?? 0);
      }
    } catch (e) {
      console.warn('relist-unsold: could not fetch view counts:', e.message);
    }

    const toRelist = unsoldIds.filter(id => (viewCounts[id] || 0) > 0 || watchCounts[id] > 0);
    console.log(`relist-unsold: ${unsoldIds.length} unsold listings, ${toRelist.length} have views/watches → relisting`);

    let relisted = 0;
    for (const oldId of toRelist) {
      try {
        const body = `<?xml version="1.0" encoding="utf-8"?><RelistFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<Item><ItemID>${oldId}</ItemID><Quantity>1</Quantity></Item></RelistFixedPriceItemRequest>`;
        const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll', body, { headers: { ...tradingHeaders, 'X-EBAY-API-CALL-NAME': 'RelistFixedPriceItem' } });
        if (/<Ack>Failure<\/Ack>/.test(xml)) {
          const errMsg = xml.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/)?.[1] || xml.match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/)?.[1] || 'unknown error';
          console.warn(`relist-unsold: failed to relist ${oldId}: ${errMsg}`);
          continue;
        }
        const newId = xml.match(/<ItemID>(\d+)<\/ItemID>/)?.[1];
        if (!newId) continue;
        relisted++;
        console.log(`relist-unsold: relisted ${oldId} → new listing ${newId} (v:${viewCounts[oldId]||0}, w:${watchCounts[oldId]||0})`);
        // Update any tracker products still pointing at the old listing ID
        await Product.updateMany({ ebayListingId: oldId }, { $set: { ebayListingId: newId } });
        if (io) io.emit('tracker:listing:relisted', { oldId, newId });
      } catch (e) {
        console.error(`relist-unsold: error relisting ${oldId}:`, e.message);
      }
    }

    console.log(`relist-unsold: done — relisted ${relisted}/${toRelist.length}`);
  } catch (e) {
    console.error('relist-unsold: error:', e.message);
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
          const decodeXmlEntities = s => (s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
          const soldSpecifics = varSpecs.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
          const soldValue = decodeXmlEntities(soldSpecifics.match(/<Value>([\s\S]*?)<\/Value>/)?.[1] || '').toLowerCase();

          const variationXml = varBlocks.map(vBlock => {
            const specs = vBlock.match(/<VariationSpecifics>([\s\S]*?)<\/VariationSpecifics>/)?.[1] || '';
            const val = decodeXmlEntities(specs.match(/<Value>([\s\S]*?)<\/Value>/)?.[1] || '').toLowerCase();
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
  // Auto-end listings 4+ days old with 0 views
  cron.schedule("0 19 * * *", runAutoEndZeroViews, { timezone: "Asia/Singapore" });
  // Auto-restock sold listings back to qty 1 — runs every 15 minutes
  cron.schedule("*/15 * * * *", runAutoRestock);
  // Orphan cleanup every 6 hours — ends any active eBay listings not in the tracker
  cron.schedule("0 */6 * * *", runOrphanCleanup);
  // Also run once shortly after startup to catch anything from the last session
  setTimeout(runOrphanCleanup, 30 * 1000);
  // Relist unsold listings that have views or watchers — runs daily at 3:30am
  cron.schedule("30 3 * * *", runRelistUnsoldWithEngagement);
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

module.exports = { start, triggerNow, checkOne: checkProduct, scheduleNew, getNextCheck, retryErrors, autoEndZeroViews: runAutoEndZeroViews, autoRestock: runAutoRestock, orphanCleanup: runOrphanCleanup, relistUnsold: runRelistUnsoldWithEngagement };
