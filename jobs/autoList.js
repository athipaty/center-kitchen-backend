/**
 * Shared auto-listing pipeline — used by:
 *   - tracker POST / (when user manually tracks a product)
 *   - productDiscovery (nightly batch)
 *
 * Reuses all data already in the Product documents so no extra ScraperAPI calls.
 */
const axios = require('axios');
const Product = require('../models/tracker/Product');
const TrackerSettings = require('../models/tracker/TrackerSettings');
const { calcEbayPrice } = require('./ebayPriceSync');

const BASE = `http://localhost:${process.env.PORT || 5000}`;

// Returns the two ambiguous labels if any variant label is a substring of another.
// e.g. "Yellow" inside "2pcs Yellow" → they clash on eBay because eBay normalises
// the longer label to match the shorter one during reprice, causing wrong prices.
// Compound labels joined by , / + (e.g. "blue,green") are intentionally distinct
// from their components and are excluded from this check.
function ambiguousVariantLabels(products) {
  if (products.length < 2) return null;
  const labels = products.map(p => (p.variant || '').toLowerCase().trim()).filter(Boolean);
  for (let i = 0; i < labels.length; i++) {
    for (let j = 0; j < labels.length; j++) {
      if (i === j) continue;
      if (!labels[j].includes(labels[i])) continue;
      // Compound supersets (joined by , / +) are clearly distinct from their
      // components on eBay — "blue,green" won't be confused with "blue".
      if (/[,/+]/.test(labels[j])) continue;
      return { subset: labels[i], superset: labels[j] };
    }
  }
  return null;
}

// Pause new listings once active eBay listing usage reaches this many slots —
// keeps headroom below eBay's monthly velocity limit (200) — and resume
// automatically once usage drops back below it. Cached briefly since the
// underlying /selling-limits call hits both eBay and an FX API.
const LISTING_CAP = 190;
let _usedListingsCache = { used: null, at: 0 };
const USED_LISTINGS_CACHE_MS = 5 * 60 * 1000;

async function getUsedListingCount() {
  const now = Date.now();
  if (_usedListingsCache.used != null && now - _usedListingsCache.at < USED_LISTINGS_CACHE_MS) {
    return _usedListingsCache.used;
  }
  try {
    const { data } = await axios.get(`${BASE}/api/ebay/selling-limits`, { timeout: 20000 });
    _usedListingsCache = { used: data.items?.used ?? null, at: now };
  } catch {
    // keep the last known value (or null if we've never fetched successfully)
  }
  return _usedListingsCache.used;
}

function detectVariantDimension(variants) {
  const labels = variants.map(v => v.variant || v.label || '');
  if (labels.some(l => /\d+["'\s]*(inch|in\b|cm\b|mm\b|oz\b|lb\b|ft\b)/i.test(l))) return 'Size';
  // Compound labels (contain / + or start with digit) are Style, not Color
  if (labels.some(l => /[\/+]/.test(l) || /^\d/.test(l))) return 'Style';
  if (labels.some(l => /\b(red|blue|green|black|white|gray|grey|pink|purple|yellow|orange|brown|natural|carbonized|silver|gold|beige|navy|teal|turquoise|coral|rose|lavender|mint|charcoal|walnut|bamboo|oak|mahogany|cherry|maple|ebony)\b/i.test(l))) return 'Color';
  return 'Style';
}

/**
 * List a group of Product mongoose documents on eBay end-to-end.
 *
 * products — array of Product docs (same group / same listing)
 * io       — socket.io server (optional, for progress events)
 *
 * Emits: tracker:auto-list:start → :step → :done | :error
 */
// Groups currently running through the listing pipeline — prevents two triggers
// (e.g. scheduleGroupAutoList's debounce firing right as the periodic retry sweep
// also picks up the same group) from racing and creating duplicate eBay listings.
const _inFlight = new Set();

// Global serial queue — listing pipelines run strictly one at a time, in the
// order they were triggered, regardless of which path (manual track, nightly
// discovery, debounced group trigger, or the periodic retry sweep) kicked them
// off. Keeps the slot-count gate above accurate (no racing creations that could
// blow past LISTING_CAP between one check and the next) and avoids hammering
// eBay with concurrent AddFixedPriceItem calls.
let _queue = Promise.resolve();

async function autoList(products, io) {
  if (!products.length) return null;

  const groupId = products[0]?.groupId || null;
  if (groupId) {
    if (_inFlight.has(groupId)) {
      console.log(`auto-list: skipping — group ${groupId} is already being listed`);
      return null;
    }
    _inFlight.add(groupId);
  }

  const task = _queue.then(() => _runAutoList(products, io));
  _queue = task.catch(() => {}); // keep the chain alive even if this run fails
  try {
    return await task;
  } finally {
    if (groupId) _inFlight.delete(groupId);
  }
}

async function _runAutoList(products, io) {
  const primary = products.find(p => p.title && p.title !== 'Unknown product') || products[0];
  const isMultiVariant = products.length > 1;
  const ids = products.map(p => String(p._id));
  const slug = (primary.specs?.asin || String(primary._id).slice(-8)).toLowerCase().replace(/[^a-z0-9]/g, '');

  function emit(event, data) { if (io) io.emit(event, { ...data, productIds: ids }); }

  // ── Gate: pause new listings while we're at/above the slot cap ──────────
  // Don't emit a start/error — that would show a permanent "failed" badge on
  // the card. Just leave the group pending; retryPendingGroups picks it back
  // up automatically (every 20 min) once usage drops back below the cap.
  const usedListings = await getUsedListingCount();
  if (usedListings != null && usedListings >= LISTING_CAP) {
    console.log(`auto-list: paused for "${primary.title?.slice(0, 60)}" — ${usedListings}/${LISTING_CAP} listing slots used; waiting until usage drops below ${LISTING_CAP}`);
    return null;
  }

  emit('tracker:auto-list:start', { title: primary.title });
  console.log(`auto-list: starting for "${primary.title?.slice(0, 60)}" (${products.length} variant(s))`);

  try {
    // ── 0. Guard: reject listings where variant labels overlap (e.g. "Yellow" ⊂ "2pcs Yellow")
    //    These cause eBay reprice to match the wrong variant, giving wrong prices permanently.
    if (isMultiVariant) {
      const clash = ambiguousVariantLabels(products);
      if (clash) {
        const msg = `Ambiguous variant labels: "${clash.subset}" is contained in "${clash.superset}" — eBay cannot reprice these reliably. Remove one variant or rename both so neither label contains the other.`;
        console.warn(`auto-list blocked: ${msg}`);
        emit('tracker:auto-list:error', { error: msg });
        return null;
      }
    }

    // ── 1. Upload images per variant (reuses saved images — no re-scrape) ──
    emit('tracker:auto-list:step', { step: 'images' });
    const variantCloudinaryImages = [];
    const variantCloudinaryFolders = [];
    for (const p of products) {
      const varImgs = [...new Set([p.image, ...(p.images || [])].filter(Boolean))].slice(0, 8);
      if (!varImgs.length) { variantCloudinaryImages.push([]); variantCloudinaryFolders.push(null); continue; }
      const varSlug = slug + (p.variant ? '-' + p.variant.toLowerCase().replace(/[^a-z0-9]/g, '') : '');
      try {
        const { data } = await axios.post(`${BASE}/api/ebay/upload-images`,
          { imageUrls: varImgs, slug: varSlug }, { timeout: 60000 });
        variantCloudinaryImages.push(data.cloudinaryUrls || []);
        variantCloudinaryFolders.push(`ebay-listings/${varSlug}`);
      } catch {
        // Don't fall back to Amazon CDN URLs — eBay's image fetcher is blocked by Amazon and
        // would silently create a blank-photo listing. Push empty so the abort guard below fires.
        variantCloudinaryImages.push([]);
        variantCloudinaryFolders.push(null);
      }
    }
    const allCloudinaryUrls = [...new Set(variantCloudinaryImages.flat())].slice(0, 12);
    if (!allCloudinaryUrls.length) {
      const msg = 'No product images could be uploaded to Cloudinary — listing aborted to prevent a blank-photo eBay listing. Check Cloudinary credentials and retry.';
      emit('tracker:auto-list:error', { error: msg });
      throw new Error(msg);
    }

    // ── 2. SEO title (Claude Haiku — cheap) ──────────────────────────────
    emit('tracker:auto-list:step', { step: 'title' });
    let ebayTitle = primary.title;
    try {
      const { data } = await axios.post(`${BASE}/api/ebay/seo-title`,
        { title: primary.title, specs: primary.specs }, { timeout: 20000 });
      if (data.title) ebayTitle = data.title;
    } catch {}

    // ── 3. HTML description (Claude Haiku) ───────────────────────────────
    emit('tracker:auto-list:step', { step: 'description' });
    let description = null;
    try {
      const { data } = await axios.post(`${BASE}/api/ebay/generate-description`, {
        title: ebayTitle,
        specs: primary.specs || {},
        imageUrls: allCloudinaryUrls,
        bullets: primary.bullets || [],
        upc: primary.upc,
        variant: primary.variant,
      }, { timeout: 60000 });
      description = data.html || null;
    } catch {}

    // ── 4. Create eBay listing ────────────────────────────────────────────
    emit('tracker:auto-list:step', { step: 'listing' });
    const settings = await TrackerSettings.findById('tracker').lean().catch(() => null);
    const saleMode = settings?.saleModeActive ?? false;

    const variantPayload = isMultiVariant ? products.map((p, i) => ({
      label: p.variant || `Variant ${i + 1}`,
      price: calcEbayPrice(p.current, saleMode).toFixed(2),
      quantity: 1,
      images: variantCloudinaryImages[i] || [],
      image: variantCloudinaryImages[i]?.[0] || null,
    })) : null;

    const payload = {
      title: ebayTitle,
      price: calcEbayPrice(primary.current, saleMode).toFixed(2),
      imageUrls: allCloudinaryUrls,
      upc: primary.upc,
      specs: primary.specs || {},
      bullets: primary.bullets || [],
      quantity: 1,
      ...(description ? { description } : {}),
      ...(isMultiVariant ? {
        variantDimension: detectVariantDimension(products),
        variants: variantPayload,
      } : {}),
    };

    let listData;
    try {
      ({ data: listData } = await axios.post(`${BASE}/api/ebay/trading-create-listing`, payload, { timeout: 180000 }));
    } catch (axErr) {
      if (axErr.response?.status === 429 || axErr.response?.data?.error === 'selling_limit_reached') {
        const limitErr = new Error('eBay selling limit reached — listing blocked by velocity check');
        limitErr.code = 'SELLING_LIMIT';
        throw limitErr;
      }
      throw axErr;
    }
    if (listData?.error === 'selling_limit_reached') {
      const limitErr = new Error('eBay selling limit reached — listing blocked by velocity check');
      limitErr.code = 'SELLING_LIMIT';
      throw limitErr;
    }
    const ebayListingId = listData.listingId || listData.itemId;
    if (!ebayListingId) throw new Error('No listing ID returned from eBay');

    // ── 5. Save listing ID + Cloudinary folder to all variants ───────────
    for (let i = 0; i < products.length; i++) {
      await Product.findByIdAndUpdate(products[i]._id, {
        ebayListingId,
        listedAt: new Date(),
        cloudinaryFolder: variantCloudinaryFolders[i] || null,
      });
    }

    // ── 6. Push variation photos (non-critical, brief eBay indexing wait) ─
    if (isMultiVariant && variantPayload) {
      emit('tracker:auto-list:step', { step: 'photos' });
      try {
        await new Promise(r => setTimeout(r, 2000));
        await axios.post(`${BASE}/api/ebay/listing/variation-photos`, {
          listingId: ebayListingId,
          variantDimension: payload.variantDimension,
          variants: variantPayload,
        }, { timeout: 60000 });
      } catch (e) {
        console.warn(`auto-list: variation photos failed for ${ebayListingId}:`, e.message);
      }
    }

    // ── 7. Verify live eBay prices match calculated prices ────────────
    try {
      await new Promise(r => setTimeout(r, 3000)); // wait for eBay to index
      const { data: livePrices } = await axios.get(`${BASE}/api/ebay/listing/${ebayListingId}/prices`, { timeout: 15000 });
      const mismatches = products.filter(p => {
        const expected = calcEbayPrice(p.current, saleMode);
        if (livePrices.variations?.length) {
          const label = (p.variant || '').toLowerCase();
          const live = livePrices.variations.find(v =>
            Object.values(v.specs).some(val => val === label || label.includes(val) || val.includes(label))
          );
          return live && Math.abs(live.price - expected) >= 0.02;
        }
        return livePrices.base && Math.abs(livePrices.base - expected) >= 0.02;
      });

      if (mismatches.length) {
        console.warn(`auto-list: ${mismatches.length} price mismatch(es) on ${ebayListingId} — auto-fixing`);
        for (const p of mismatches) {
          const expected = calcEbayPrice(p.current, saleMode);
          try {
            await axios.post(`${BASE}/api/ebay/listing/price`, {
              listingId: ebayListingId,
              price: expected,
              variantLabel: p.variant || '',
            }, { timeout: 15000 });
            console.log(`auto-list: fixed price for variant "${p.variant}" → $${expected.toFixed(2)}`);
          } catch (e) {
            console.warn(`auto-list: price fix failed for variant "${p.variant}":`, e.message);
          }
        }
      } else {
        console.log(`auto-list: prices verified ✓ ${ebayListingId} (${products.length} variant(s))`);
      }
    } catch (e) {
      console.warn(`auto-list: price verification skipped for ${ebayListingId}:`, e.message);
    }

    emit('tracker:auto-list:done', { ebayListingId, title: ebayTitle });
    console.log(`auto-list: ✓ ${ebayListingId} "${ebayTitle.slice(0, 60)}" (${products.length} variant(s))`);
    return ebayListingId;

  } catch (e) {
    const msg = e.response?.data?.error || e.message || String(e);
    emit('tracker:auto-list:error', { error: msg });
    console.error(`auto-list: failed for "${primary.title?.slice(0, 60)}":`, msg);
    throw e;
  }
}

// Debounce map: groupId → timeout handle
// Lets all variants in a group get saved before the listing pipeline fires.
const _pending = {};

function scheduleGroupAutoList(groupId, io) {
  if (_pending[groupId]) clearTimeout(_pending[groupId]);
  _pending[groupId] = setTimeout(async () => {
    delete _pending[groupId];
    try {
      const products = await Product.find({ groupId, ebayListingId: null, isPrime: true, status: { $ne: 'archived' } });
      if (products.length) await autoList(products, io);
      // Refresh frontend so eBay listing IDs appear on cards
      if (io) io.emit('tracker:check:done', { time: new Date().toISOString(), results: [] });
    } catch {}
  }, 180000); // 180s — ScraperAPI takes ~15s per variant; 6 variants = ~90s, 180s gives safe headroom
}

// Safety net for groups whose scheduleGroupAutoList timer was lost (e.g. a server
// restart mid-debounce) — the only other trigger (productDiscovery's pending retry)
// only runs when listing slots get freed, so groups can otherwise stay stuck forever
// showing "Will auto-list when Prime confirmed" despite isPrime already being true.
//
// Finds Prime groups with no listing whose newest variant is "stable" (created more
// than STALE_MS ago, so we don't race scheduleGroupAutoList while a group is still
// being populated), and runs the listing pipeline for them.
const STALE_MS = 10 * 60 * 1000; // 10 min — comfortably longer than the 180s debounce
let _retryRunning = false;

// How many times a group can hit eBay's [240] "selling limit" error before we treat
// it as a permanent block (e.g. brand/trademark restriction — eBay returns the same
// generic 240 + "request a limit increase" templated text for both a real account-wide
// velocity limit AND a per-listing policy/VeRO block, so the message text alone can't
// tell them apart). Real velocity limits affect every listing attempt; if OTHER groups
// keep listing successfully while this one keeps failing, it's the listing, not the limit.
const LISTING_BLOCK_THRESHOLD = 2;

async function retryPendingGroups(io) {
  if (_retryRunning) return;
  _retryRunning = true;
  try {
    const cutoff = new Date(Date.now() - STALE_MS);
    const pending = await Product.find({
      ebayListingId: null, isPrime: true, listingBlocked: { $ne: true },
      groupId: { $exists: true, $ne: null },
      status: { $ne: 'archived' },
    }).lean();
    if (!pending.length) return;

    const groups = {};
    for (const p of pending) {
      (groups[p.groupId] ||= []).push(p);
    }

    for (const [groupId, variants] of Object.entries(groups)) {
      if (_pending[groupId]) continue; // scheduleGroupAutoList already has this queued
      const newestCreatedAt = variants.reduce((max, p) => (p.createdAt > max ? p.createdAt : max), variants[0].createdAt);
      if (new Date(newestCreatedAt) > cutoff) continue; // still mid-add — let the debounce handle it

      try {
        const docs = await Product.find({ groupId, ebayListingId: null, status: { $ne: 'archived' } });
        if (!docs.length) continue;
        console.log(`auto-list retry: picking up stale pending group ${groupId} (${docs.length} variant(s))`);
        await autoList(docs, io);
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        if (e.code === 'SELLING_LIMIT') {
          // Atomic increment+read on one representative doc avoids a stale-count race
          // when multiple sweeps (e.g. startup sweep + cron) overlap on the same group.
          const sample = await Product.findOneAndUpdate(
            { _id: variants[0]._id },
            { $inc: { listFailCount: 1 } },
            { new: true }
          ).select('listFailCount specs').lean();
          const failCount = sample.listFailCount;
          if (failCount >= LISTING_BLOCK_THRESHOLD) {
            const brand = sample.specs?.brand_name || sample.specs?.manufacturer || null;
            const reason = `eBay rejected this listing with error 240 ("selling limit"/policy block) ${failCount} times while other groups listed successfully in between — likely a brand/trademark restriction${brand ? ` (brand: "${brand}")` : ''}, not a real account-wide limit. Giving up automatic retries; relist manually if you have authorization to sell this brand.`;
            await Product.updateMany({ groupId }, { listingBlocked: true, listingBlockReason: reason, listFailCount: failCount });
            console.warn(`auto-list retry: group ${groupId} permanently blocked — ${reason}`);
          } else {
            await Product.updateMany({ groupId, _id: { $ne: sample._id } }, { listFailCount: failCount });
            console.warn(`auto-list retry: selling limit hit for group ${groupId} (attempt ${failCount}/${LISTING_BLOCK_THRESHOLD}) — will retry later`);
          }
          continue; // don't abort the whole sweep — other groups aren't necessarily affected
        }
        console.error(`auto-list retry: failed for group ${groupId}:`, e.message);
      }
    }
  } finally {
    _retryRunning = false;
  }
}

module.exports = { autoList, scheduleGroupAutoList, retryPendingGroups, calcEbayPrice, detectVariantDimension, getUsedListingCount };
