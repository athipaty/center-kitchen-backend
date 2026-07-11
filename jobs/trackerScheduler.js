const cron = require("node-cron");
const axios = require("axios");
const { fetchProduct } = require("../scraper");
const Product = require("../models/tracker/Product");
const Order = require("../models/tracker/Order");
const { syncEbayPrice, syncEbayQty, endListing, removeVariation, getAccessToken, calcEbayPrice, bestVariantMatch } = require("./ebayPriceSync");
const { deleteCloudinaryFolder } = require("../utils/cloudinaryUtils");
const { b2Enabled, listB2Files, deleteB2Prefix } = require("../utils/b2Utils");
const { ntfyPush } = require("../utils/ntfy");

let io = null;

// When eBay hits a daily call-limit, pause all Trading API calls until midnight PDT
// (07:00 UTC) rather than hammering retry loops that can't succeed.
let _ebayRateLimitedUntil = 0;
function isEbayRateLimited() { return Date.now() < _ebayRateLimitedUntil; }
function markEbayRateLimited(msg) {
  if (_ebayRateLimitedUntil > Date.now()) return; // already set
  // Reset at next midnight PDT (UTC-7). Calculate ms until 07:00 UTC today/tomorrow.
  const now = new Date();
  const resetUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7, 0, 0));
  if (resetUtc <= now) resetUtc.setUTCDate(resetUtc.getUTCDate() + 1);
  _ebayRateLimitedUntil = resetUtc.getTime();
  console.warn(`eBay rate-limited — pausing all Trading API calls until ${resetUtc.toISOString()} (midnight PDT). Error: ${msg}`);
}

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
  if (daysSinceChange >= 14) return (Math.random() * 12 + 60) * 3600 * 1000; // 60–72h
  if (daysSinceChange >= 7)  return (Math.random() * 12 + 36) * 3600 * 1000; // 36–48h
  if (daysSinceChange >= 3)  return (Math.random() * 4  + 8)  * 3600 * 1000; // 8–12h
  return                            (Math.random() * 2  + 3)  * 3600 * 1000; // 3–5h
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

async function checkProduct(p, syncedListings = null) {
  try {
    // Scheduler only needs price + stock status — always priceOnly=true.
    // This guarantees exactly 1 Keepa token per product regardless of what metadata
    // is in the DB. Full metadata (title, image, specs) is fetched once at add-time
    // via POST /api/tracker and never needs to be re-fetched during routine checks.
    const info = await fetchProduct(p.url, { priceOnly: true });
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

    const priceChanged  = info.price !== oldPrice;
    const justRestocked = previousStatus !== 'active';

    // Calculate the eBay price but don't write it to the DB yet — only update
    // p.ebayPrice after a successful sync so a failed call doesn't make the tracker
    // think eBay is already correct (which would suppress all future retries).
    const oldEbayPrice = p.ebayPrice;
    const newEbayPrice = p.ebayListingId ? calcEbayPrice(info.price) : null;

    const ebayPriceChanged = newEbayPrice != null && (oldEbayPrice == null || Math.abs(newEbayPrice - oldEbayPrice) > 0.005);
    const alreadySynced = syncedListings && p.ebayListingId && syncedListings.has(String(p.ebayListingId));
    if (alreadySynced) {
      // A sibling variant already called ReviseFixedPriceItem for this listing this batch,
      // pricing all variations — safe to record the new price without another API call.
      if (newEbayPrice != null) p.ebayPrice = newEbayPrice;
      console.log(`eBay sync skipped (already synced this batch): listing ${p.ebayListingId}`);
    }
    if (p.ebayListingId && (ebayPriceChanged || justRestocked) && !isEbayRateLimited() && !alreadySynced) {
      let syncErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (ebayPriceChanged) await syncEbayPrice(p.ebayListingId, info.price, p.variant);
          if (justRestocked) {
            await syncEbayQty(p.ebayListingId, p.variant, 1);
            console.log(`eBay qty restored: listing ${p.ebayListingId} variant="${p.variant}" → 1 (was ${previousStatus})`);
          }
          if (ebayPriceChanged) {
            p.ebayPrice = newEbayPrice; // only record after confirmed success
            console.log(`eBay price synced: listing ${p.ebayListingId} variant="${p.variant}" amazon=$${info.price} → ebay=$${newEbayPrice}`);
          }
          if (syncedListings && p.ebayListingId) syncedListings.add(String(p.ebayListingId));
          syncErr = null;
          break;
        } catch (e) {
          syncErr = e;
          // Don't retry daily call-limit errors — they won't clear for hours
          if (e.message?.includes('exceeded usage limit')) {
            markEbayRateLimited(e.message);
            break;
          }
          if (attempt < 2) {
            console.warn(`eBay sync attempt ${attempt} failed for ${p.ebayListingId}: ${e.message} — retrying in 8s`);
            await new Promise(r => setTimeout(r, 8000));
          }
        }
      }
      if (syncErr) {
        // p.ebayPrice retains oldEbayPrice — next check will detect the mismatch and retry
        console.error(`eBay price sync failed for listing ${p.ebayListingId} after 2 attempts:`, syncErr.message);
        if (io) io.emit('tracker:ebay:sync:fail', { productId: String(p._id), error: syncErr.message });
      } else {
        if (io) io.emit('tracker:ebay:sync:ok', { productId: String(p._id) });
      }
      // Keepa processes products ~30× faster than the old scraper, causing burst eBay API calls.
      // Throttle to ≤1 sync per 5s to stay within eBay's per-minute rate limit.
      if (!isEbayRateLimited()) await new Promise(r => setTimeout(r, 5000));
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

    // If this variant is on an eBay listing but ebayPrice was never set (e.g. went OOS before
    // the first successful sync), seed it from the live eBay variation price so the UI shows
    // "eBay ✓" instead of "Not listed".
    if (p.ebayListingId && p.ebayPrice == null) {
      try {
        const { getAccessToken } = require('./ebayPriceSync');
        const axios = require('axios');
        const token = await getAccessToken();
        const cleanId = String(p.ebayListingId).trim().replace(/\D/g, '');
        const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
        const { data: xml } = await axios.post('https://api.ebay.com/ws/api.dll',
          `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<ItemID>${cleanId}</ItemID></GetItemRequest>`,
          { headers: { 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-CALL-NAME': 'GetItem', 'X-EBAY-API-IAF-TOKEN': token, 'Content-Type': 'text/xml' } }
        );
        const varLabel = (p.variant || '').toLowerCase().trim();
        const varBlocks = [...xml.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)].map(m => m[0]);
        if (varBlocks.length === 0) {
          const singlePrice = xml.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1];
          if (singlePrice) { p.ebayPrice = parseFloat(singlePrice); console.log(`ebayPrice seeded from live eBay: ${p.ebayListingId} "${p.variant}" → $${p.ebayPrice}`); }
        } else {
          for (const block of varBlocks) {
            const val = (block.match(/<Value>([\s\S]*?)<\/Value>/i)?.[1] || '').toLowerCase().trim();
            if (val === varLabel || val.includes(varLabel) || (varLabel && varLabel.includes(val) && val.length > 2)) {
              const price = block.match(/<StartPrice[^>]*>([\d.]+)<\/StartPrice>/)?.[1];
              if (price) { p.ebayPrice = parseFloat(price); console.log(`ebayPrice seeded from live eBay: ${p.ebayListingId} "${p.variant}" → $${p.ebayPrice}`); break; }
            }
          }
        }
      } catch (seedErr) {
        console.warn(`ebayPrice seed failed for ${p._id}: ${seedErr.message}`);
      }
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

  if (isEbayRateLimited()) return;
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

let _dueChecksRunning = false;

async function runDueChecks() {
  // At larger catalog sizes a batch of due products can take longer than the 5-minute
  // cron interval to process (each eBay sync is throttled to 1 per 5s). Without this
  // guard the next tick would start a second pass over overlapping products, causing
  // duplicate eBay API calls and racy p.save() writes.
  if (_dueChecksRunning) {
    console.warn('runDueChecks: previous run still in progress — skipping this tick');
    return;
  }
  _dueChecksRunning = true;
  try {
    await checkDeadListings();
    const due = await Product.find({ nextCheck: { $lte: new Date() } });
    if (!due.length) return;

    if (io) io.emit("tracker:check:start", { count: due.length, time: new Date().toISOString() });

    const results = [];
    const syncedListings = new Set();
    for (const p of due) {
      results.push(await checkProduct(p, syncedListings));
    }

    if (io) io.emit("tracker:check:done", { time: new Date().toISOString(), results });
  } finally {
    _dueChecksRunning = false;
  }
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

// Weekly variation sync: for every multi-variation listing, remove any eBay variations
// that no longer exist in the tracker DB. "If anything doesn't match, delete it."
async function runWeeklyVariationSync() {
  console.log('weekly-variation-sync: starting…');
  const PORT = process.env.PORT || 5000;
  try {
    const token = await getAccessToken();
    const products = await Product.find({ ebayListingId: { $exists: true, $ne: null } }).lean();

    // Group by listing ID
    const byListing = {};
    for (const p of products) {
      const id = String(p.ebayListingId);
      if (!byListing[id]) byListing[id] = [];
      byListing[id].push(p);
    }

    let fixed = 0;
    for (const [listingId, dbVariants] of Object.entries(byListing)) {
      try {
        // Fetch live eBay variations via the local API (reuses caching + auth logic)
        const { data: priceData } = await axios.get(`http://localhost:${PORT}/api/ebay/listing/${listingId}/prices`, { timeout: 20000 });
        const ebayVariations = priceData.variations || [];
        if (ebayVariations.length === 0) continue; // single listing — no variation sync needed

        const dbLabels = dbVariants.map(p => (p.variant || '').toLowerCase().trim()).filter(Boolean);

        const extraOnEbay = ebayVariations.filter(ev => {
          const ebayLabel = Object.values(ev.specs || {})[0]?.toString().toLowerCase().trim() || '';
          return !dbLabels.some(dl => dl === ebayLabel || dl.includes(ebayLabel) || ebayLabel.includes(dl));
        });

        for (const extra of extraOnEbay) {
          const ebayLabel = Object.values(extra.specs || {})[0]?.toString() || '';
          console.log(`weekly-variation-sync: removing extra eBay variation "${ebayLabel}" from listing ${listingId}`);
          await removeVariation(listingId, ebayLabel);
          fixed++;
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (e) {
        console.error(`weekly-variation-sync: error on listing ${listingId}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`weekly-variation-sync: done — ${fixed} extra variation(s) removed`);
  } catch (e) {
    console.error('weekly-variation-sync: failed:', e.message);
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

    // Fetch ALL active eBay listings with watch counts — paginate until no more.
    // Page cap is just a safety net against a runaway loop; the real stop condition
    // is HasMoreItems below. At 200 entries/page this covers 40,000 listings.
    const allEbayIds = [];
    const watchCountMap = {}; // listingId → watchCount
    for (let page = 1; page <= 200; page++) {
      const xml = `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ActiveList><Include>true</Include><IncludeWatchCount>true</IncludeWatchCount><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList></GetMyeBaySellingRequest>`;
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
      await new Promise(r => setTimeout(r, 3000));
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

    // Zero views AND zero watchers — anything with buyer interest is kept regardless.
    const zeroViewIds = oldListings.filter(id => viewCounts[id] === 0 && (watchCounts[id] || 0) === 0);
    const kept = oldListings.filter(id => viewCounts[id] > 0 || (watchCounts[id] || 0) > 0);
    if (kept.length) {
      console.log(`auto-end-zero-views: keeping ${kept.length} listing(s) with views/watches: ${kept.map(id => `${id}(v:${viewCounts[id]},w:${watchCounts[id]||0})`).join(', ')}`);
    }
    if (!zeroViewIds.length) {
      console.log('auto-end-zero-views: no zero-view listings found');
      return;
    }

    // A zero-view listing gets one retitle rescue attempt before it's ever ended — a bad
    // title is a more common cause of zero views than genuinely no demand. Only actually
    // ends it if it's STILL at zero 3 days after that rescue attempt.
    const rescueDocs = await Product.find(
      { ebayListingId: { $in: zeroViewIds } }, 'ebayListingId zeroViewRescueAt'
    ).lean();
    const rescuedAtByListing = {};
    for (const d of rescueDocs) {
      if (d.zeroViewRescueAt) rescuedAtByListing[d.ebayListingId] = d.zeroViewRescueAt;
    }

    const RESCUE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
    const toRescue = [];
    const toEnd = [];
    for (const id of zeroViewIds) {
      const rescuedAt = rescuedAtByListing[id];
      if (!rescuedAt) toRescue.push(id);
      else if (Date.now() - new Date(rescuedAt).getTime() >= RESCUE_WINDOW_MS) toEnd.push(id);
      // else: still inside its 3-day post-rescue observation window — leave it alone
    }

    if (toRescue.length) {
      console.log(`auto-end-zero-views: ${toRescue.length} zero-view listing(s) getting a retitle rescue: ${toRescue.join(', ')}`);
      try {
        await axios.post(`http://localhost:${process.env.PORT || 5000}/api/ebay/batch-optimize`, { listingIds: toRescue });
        await Product.updateMany({ ebayListingId: { $in: toRescue } }, { $set: { zeroViewRescueAt: new Date() } });
      } catch (e) {
        console.error('auto-end-zero-views: rescue optimize failed:', e.message);
      }
    }

    if (!toEnd.length) {
      console.log('auto-end-zero-views: no listings past their rescue window yet');
      return;
    }
    console.log(`auto-end-zero-views: ${toEnd.length} listing(s) still zero views 7+ days after rescue → ending`);

    for (const listingId of toEnd) {
      try {
        await endListing(listingId);
        const linked = await Product.find({ ebayListingId: listingId });
        const folders = [...new Set(linked.map(p => p.cloudinaryFolder).filter(Boolean))];
        await Product.deleteMany({ ebayListingId: listingId });
        for (const folder of folders) {
          await deleteB2Prefix(folder + '/').catch(() => {});
        }
        console.log(`auto-end-zero-views: deleted listing ${listingId} (${linked.length} variant slot(s) freed)`);
      } catch (e) {
        console.error(`auto-end-zero-views: failed to end ${listingId}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 3000));
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

    // Fetch unsold listings (ended in the last 60 days) with watch counts.
    // Page cap is a safety net, not the stop condition — see HasMoreItems below.
    const unsoldIds = [];
    const watchCounts = {};
    for (let page = 1; page <= 200; page++) {
      const xml = `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<UnsoldList><Include>true</Include><IncludeWatchCount>true</IncludeWatchCount><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination><DurationInDays>60</DurationInDays></UnsoldList></GetMyeBaySellingRequest>`;
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

    // Only relist listings the tracker actually owns — otherwise old/manual eBay
    // listings with leftover views or watchers get swept up and relisted forever.
    const trackedProducts = await Product.find({ ebayListingId: { $in: unsoldIds } }, 'ebayListingId').lean();
    const trackedIds = new Set(trackedProducts.map(p => String(p.ebayListingId)));

    const toRelist = unsoldIds.filter(id => trackedIds.has(id) && ((viewCounts[id] || 0) > 0 || watchCounts[id] > 0));
    console.log(`relist-unsold: ${unsoldIds.length} unsold listings, ${toRelist.length} tracked with views/watches → relisting`);

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
async function runAutoRestock(lookbackMs = 35 * 60 * 1000) {
  if (isEbayRateLimited()) return;
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

    const from = new Date(Date.now() - lookbackMs).toISOString();
    const to   = new Date().toISOString();

    const { data: ordersXml } = await tradingPost('GetOrders',
      `<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}<CreateTimeFrom>${from}</CreateTimeFrom><CreateTimeTo>${to}</CreateTimeTo><OrderStatus>All</OrderStatus><DetailLevel>ReturnAll</DetailLevel></GetOrdersRequest>`
    );

    // ── Capture full order + buyer/shipping details for the fulfillment tracker ──
    // Reuses the GetOrders response above rather than making a second eBay call.
    try {
      const decodeXmlEntities = s => (s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      const orderBlocksFull = [...ordersXml.matchAll(/<Order>([\s\S]*?)<\/Order>/g)];
      for (const [, orderXml] of orderBlocksFull) {
        const ebayOrderId = orderXml.match(/<OrderID>([\s\S]*?)<\/OrderID>/)?.[1];
        if (!ebayOrderId) continue;

        const buyerUserId = orderXml.match(/<BuyerUserID>([\s\S]*?)<\/BuyerUserID>/)?.[1] || null;
        const createTimeEbay = orderXml.match(/<CreatedTime>([\s\S]*?)<\/CreatedTime>/)?.[1];
        const addrXml = orderXml.match(/<ShippingAddress>([\s\S]*?)<\/ShippingAddress>/)?.[1] || '';
        const shippingAddress = {
          name: decodeXmlEntities(addrXml.match(/<Name>([\s\S]*?)<\/Name>/)?.[1]) || null,
          street1: decodeXmlEntities(addrXml.match(/<Street1>([\s\S]*?)<\/Street1>/)?.[1]) || null,
          street2: decodeXmlEntities(addrXml.match(/<Street2>([\s\S]*?)<\/Street2>/)?.[1]) || null,
          cityName: decodeXmlEntities(addrXml.match(/<CityName>([\s\S]*?)<\/CityName>/)?.[1]) || null,
          stateOrProvince: decodeXmlEntities(addrXml.match(/<StateOrProvince>([\s\S]*?)<\/StateOrProvince>/)?.[1]) || null,
          postalCode: addrXml.match(/<PostalCode>([\s\S]*?)<\/PostalCode>/)?.[1] || null,
          country: addrXml.match(/<Country>([\s\S]*?)<\/Country>/)?.[1] || null,
          phone: addrXml.match(/<Phone>([\s\S]*?)<\/Phone>/)?.[1] || null,
        };

        const txBlocksFull = [...orderXml.matchAll(/<Transaction>([\s\S]*?)<\/Transaction>/g)];
        for (const [, tx] of txBlocksFull) {
          const ebayItemId = tx.match(/<ItemID>(\d+)<\/ItemID>/)?.[1] || null;
          if (!ebayItemId) continue;
          const title = decodeXmlEntities(tx.match(/<Title>([\s\S]*?)<\/Title>/)?.[1]) || null;
          const variationValue = decodeXmlEntities(tx.match(/<Variation>[\s\S]*?<Value>([\s\S]*?)<\/Value>/)?.[1]) || null;
          const quantity = parseInt(tx.match(/<QuantityPurchased>(\d+)<\/QuantityPurchased>/)?.[1] || '1', 10);
          const price = parseFloat(tx.match(/<TransactionPrice[^>]*>([\d.]+)<\/TransactionPrice>/)?.[1] || '0') || null;

          const result = await Order.findOneAndUpdate(
            { ebayOrderId, ebayItemId, variationValue },
            { $setOnInsert: {
              ebayOrderId, ebayItemId, title, variationValue, quantity, price,
              buyerUserId, shippingAddress,
              createTimeEbay: createTimeEbay ? new Date(createTimeEbay) : null,
            } },
            { upsert: true, new: true, rawResult: true }
          );
          if (result.lastErrorObject?.upserted && io) io.emit('tracker:order:new', { order: result.value });
        }
      }
    } catch (e) {
      console.error('order-capture: error:', e.message);
    }

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
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (e) {
    console.error('auto-restock: error:', e.message);
  }
}

// eBay expects tracking uploaded within this many hours of payment (handling time) —
// past this it's a late shipment against seller performance metrics. deadlineAlertsSent
// tracks which tier already fired per order so this doesn't re-alert every 15 minutes.
const SHIP_DEADLINE_HOURS = 24;

// Ordered most-urgent-first. When a check finds hoursLeft has dropped past more than
// one threshold at once (e.g. after the server was down a while), it sends only the
// single most urgent unsent tier and marks the less-urgent ones sent too, rather than
// firing a burst of stale warnings back to back.
const WARN_TIERS = [
  { key: 'warn2h',  hoursLeft: 2,  title: '🔴 ด่วนมาก! ใกล้เกินกำหนด',
    priority: 'urgent', tags: ['red_circle'] },
  { key: 'warn6h',  hoursLeft: 6,  title: '⏰ ใกล้ครบกำหนด',
    priority: 'high', tags: ['alarm_clock'] },
  { key: 'warn12h', hoursLeft: 12, title: '🔔 เตือนล่วงหน้า',
    priority: 'default', tags: ['bell'] },
];

// Bumps lateShipmentCount on the Product doc(s) backing this order's listing/variant,
// so chronically-late SKUs are visible and their eBay handling time can be adjusted.
async function flagLateShipment(order) {
  try {
    const candidates = await Product.find({ ebayListingId: order.ebayItemId });
    if (!candidates.length) return;
    const match = order.variationValue ? bestVariantMatch(candidates, order.variationValue) : candidates[0];
    if (match) await Product.updateOne({ _id: match._id }, { $inc: { lateShipmentCount: 1 } });
  } catch (e) {
    console.error('flagLateShipment: error:', e.message);
  }
}

async function runShippingDeadlineCheck() {
  try {
    const unshipped = await Order.find({ trackingNumber: null, createTimeEbay: { $ne: null } });
    const now = Date.now();

    for (const o of unshipped) {
      const hoursLeft = (o.createTimeEbay.getTime() + SHIP_DEADLINE_HOURS * 3600 * 1000 - now) / 3600000;
      const alerts = o.deadlineAlertsSent || [];
      const label = o.title || o.ebayItemId || o.ebayOrderId;

      if (hoursLeft <= 0) {
        if (!alerts.includes('overdue24h')) {
          const sent = await ntfyPush(
            '🚨 เกินกำหนดส่งของแล้ว',
            `"${label}" (order ${o.ebayOrderId}) เกิน 24 ชม. หลังชำระเงิน ${Math.abs(hoursLeft).toFixed(1)} ชม. — ใส่เลขพัสดุด่วน!`,
            { priority: 'urgent', tags: ['rotating_light'] }
          );
          if (sent) {
            o.deadlineAlertsSent = [...alerts, 'overdue24h'];
            await o.save();
            await flagLateShipment(o);
          }
        }
        continue;
      }

      const tier = WARN_TIERS.find(t => hoursLeft <= t.hoursLeft && !alerts.includes(t.key));
      if (!tier) continue;

      const sent = await ntfyPush(
        tier.title,
        `"${label}" (order ${o.ebayOrderId}) เหลือเวลาอีก ${hoursLeft.toFixed(1)} ชม. ก่อนเกิน 24 ชม. — กรุณาใส่เลขพัสดุ`,
        { priority: tier.priority, tags: tier.tags }
      );
      if (sent) {
        // Mark this tier and every less-urgent tier as sent — they're moot now.
        const supersededKeys = WARN_TIERS.filter(t => t.hoursLeft >= tier.hoursLeft).map(t => t.key);
        o.deadlineAlertsSent = [...new Set([...alerts, ...supersededKeys])];
        await o.save();
      }
    }
  } catch (e) {
    console.error('shipping-deadline-check: error:', e.message);
  }
}

// Delete Cloudinary folders that are no longer linked to any tracked product.
// Covers both tracker-images/ and ebay-listings/ prefixes.
async function runCloudinaryCleanup() {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloud || !apiKey || !apiSecret) return;

  try {
    console.log('cloudinaryCleanup: starting weekly orphan cleanup');

    // 1. Collect all folder paths still in use by active products
    const products = await Product.find({}, { _id: 1, url: 1, cloudinaryFolder: 1 }).lean();
    const activeFolders = new Set();
    for (const p of products) {
      if (p.cloudinaryFolder) activeFolders.add(p.cloudinaryFolder);
      // Only protect tracker-images/ if the product hasn't been listed yet.
      // Once listed, cloudinaryFolder is updated to ebay-listings/ and the tracker-images/
      // folder is redundant — let the cleanup reclaim it.
      if (!p.cloudinaryFolder || p.cloudinaryFolder.startsWith('tracker-images/')) {
        const asin = (p.url || '').match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || p._id.toString();
        const slug = `${p._id}-${asin}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
        activeFolders.add(`tracker-images/${slug}`);
      }
    }

    // 2. List all images under both prefixes, extract unique folder names
    const auth = { username: apiKey, password: apiSecret };
    const orphans = new Set();
    for (const prefix of ['tracker-images/', 'ebay-listings/']) {
      let nextCursor = null;
      do {
        const params = new URLSearchParams({ prefix, max_results: '200', type: 'upload' });
        if (nextCursor) params.set('next_cursor', nextCursor);
        const { data } = await axios.get(
          `https://api.cloudinary.com/v1_1/${cloud}/resources/image?${params}`,
          { auth, timeout: 15000 }
        );
        for (const r of data.resources || []) {
          const parts = r.public_id.split('/');
          if (parts.length >= 2) {
            const folder = parts[0] + '/' + parts[1];
            if (!activeFolders.has(folder)) orphans.add(folder);
          }
        }
        nextCursor = data.next_cursor || null;
      } while (nextCursor);
    }

    if (!orphans.size) {
      console.log('cloudinaryCleanup: no orphaned folders found');
      return;
    }
    console.log(`cloudinaryCleanup: deleting ${orphans.size} orphaned folders`);

    // 3. Delete orphans one at a time to avoid Cloudinary 420 rate limit
    let deleted = 0, failed = 0;
    for (const folder of orphans) {
      try {
        await deleteCloudinaryFolder(folder);
        deleted++;
      } catch (e) {
        console.warn(`cloudinaryCleanup: failed to delete ${folder}:`, e.message);
        failed++;
      }
      await new Promise(r => setTimeout(r, 1000)); // 1s gap between deletions
    }
    console.log(`cloudinaryCleanup: done — ${deleted} deleted, ${failed} failed`);
  } catch (e) {
    console.error('cloudinaryCleanup: error:', e.message);
  }

  // B2 orphan cleanup — mirrors the Cloudinary pass above
  if (!b2Enabled()) return;
  try {
    const products = await Product.find({}, { _id: 1, url: 1, cloudinaryFolder: 1 }).lean();
    const activeFolders = new Set();
    for (const p of products) {
      if (p.cloudinaryFolder) activeFolders.add(p.cloudinaryFolder);
      if (!p.cloudinaryFolder || p.cloudinaryFolder.startsWith('tracker-images/')) {
        const asin = (p.url || '').match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || p._id.toString();
        const slug = `${p._id}-${asin}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
        activeFolders.add(`tracker-images/${slug}`);
      }
    }

    const b2Orphans = new Set();
    for (const prefix of ['tracker-images/', 'ebay-listings/']) {
      const urls = await listB2Files(prefix).catch(() => []);
      for (const url of urls) {
        const key = url.replace(/^https?:\/\/[^/]+\/file\/[^/]+\//, '');
        const parts = key.split('/');
        if (parts.length >= 2) {
          const folder = parts[0] + '/' + parts[1];
          if (!activeFolders.has(folder)) b2Orphans.add(folder);
        }
      }
    }

    if (!b2Orphans.size) {
      console.log('b2Cleanup: no orphaned prefixes found');
      return;
    }
    console.log(`b2Cleanup: deleting ${b2Orphans.size} orphaned prefixes`);
    for (const folder of b2Orphans) {
      await deleteB2Prefix(folder + '/').catch(e => console.warn(`b2Cleanup: failed ${folder}:`, e.message));
    }
    console.log('b2Cleanup: done');
  } catch (e) {
    console.error('b2Cleanup: error:', e.message);
  }
}

function start(socketIo) {
  io = socketIo;
  // Check every 5 minutes which products are due
  cron.schedule("*/5 * * * *", runDueChecks);
  // Re-optimize all listings every Sunday at 3am
  cron.schedule("0 3 * * 0", runWeeklyOptimize);
  // Variation sync: remove eBay variations not in tracker — Sunday 3:15am (after optimize)
  cron.schedule("15 3 * * 0", runWeeklyVariationSync);
  // Zero-view listings (4+ days old): retitle once as a rescue attempt, only end them if
  // still zero-view 3 days after that — daily at 19:00 Singapore time
  cron.schedule("0 19 * * *", runAutoEndZeroViews, { timezone: "Asia/Singapore" });
  // Auto-restock sold listings back to qty 1 — runs every 30 minutes (was 15, halves GetOrders calls)
  cron.schedule("*/30 * * * *", () => runAutoRestock());
  // Orphan cleanup once daily at 1am — was every 6h + startup (saves ~44 GetMyeBaySelling calls/day)
  cron.schedule("0 1 * * *", runOrphanCleanup);
  // Relist unsold listings that have views or watchers — runs daily at 3:30am
  cron.schedule("30 3 * * *", runRelistUnsoldWithEngagement);
  // Cloudinary orphan cleanup — weekly Sunday 2am (between price-optimize jobs)
  cron.schedule("0 2 * * 0", runCloudinaryCleanup);
  // Shipping-deadline check — every 15 minutes so a 6-hour warning window is never missed
  cron.schedule("*/15 * * * *", runShippingDeadlineCheck);
}

// Called when user clicks "Check Now" for a specific product or all products
async function triggerNow() {
  const products = await Product.find();
  if (!products.length) return;

  if (io) io.emit("tracker:check:start", { count: products.length, time: new Date().toISOString() });

  const results = [];
  const syncedListings = new Set();
  for (let i = 0; i < products.length; i++) {
    results.push(await checkProduct(products[i], syncedListings));
    if (i < products.length - 1) await new Promise(r => setTimeout(r, 10000));
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

module.exports = { start, triggerNow, checkOne: checkProduct, scheduleNew, getNextCheck, retryErrors, autoEndZeroViews: runAutoEndZeroViews, autoRestock: runAutoRestock, orphanCleanup: runOrphanCleanup, relistUnsold: runRelistUnsoldWithEngagement, cloudinaryCleanup: runCloudinaryCleanup, shippingDeadlineCheck: runShippingDeadlineCheck };
