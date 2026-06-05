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

const BASE = `http://localhost:${process.env.PORT || 5000}`;

const EBAY_FEE = 0.1325, FIXED_FEE = 0.30, PROMO = 0.05, MIN_PROFIT = 4.50, AMAZON_TAX = 0.085;

function calcEbayPrice(cost, saleMode = false) {
  const c = cost * (1 + AMAZON_TAX);
  if (saleMode) return Math.floor((c + FIXED_FEE) / (1 - EBAY_FEE - PROMO - 0.02)) + 0.99;
  const m = c < 10 ? 2.2 : c < 20 ? 1.7 : c < 35 ? 1.55 : c < 60 ? 1.45 : 1.35;
  return Math.floor(Math.max(c * m, (c + MIN_PROFIT + FIXED_FEE) / (1 - EBAY_FEE))) + 0.99;
}

// Returns the two ambiguous labels if any variant label is a substring of another.
// e.g. "Yellow" inside "2pcs Yellow" → they clash on eBay because eBay normalises
// the longer label to match the shorter one during reprice, causing wrong prices.
function ambiguousVariantLabels(products) {
  if (products.length < 2) return null;
  const labels = products.map(p => (p.variant || '').toLowerCase().trim()).filter(Boolean);
  for (let i = 0; i < labels.length; i++) {
    for (let j = 0; j < labels.length; j++) {
      if (i !== j && labels[j].includes(labels[i])) {
        return { subset: labels[i], superset: labels[j] };
      }
    }
  }
  return null;
}

function detectVariantDimension(variants) {
  if (variants.some(v => (v.variant || v.label || '').match(/\d+["'\s]*(inch|in\b|cm\b|mm\b|oz\b|lb\b|ft\b)/i))) return 'Size';
  if (variants.some(v => (v.variant || v.label || '').match(/\b(red|blue|green|black|white|gray|grey|pink|purple|yellow|orange|brown|natural|carbonized|silver|gold|beige|navy|teal)\b/i))) return 'Color';
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
async function autoList(products, io) {
  if (!products.length) return null;

  const primary = products.find(p => p.title && p.title !== 'Unknown product') || products[0];
  const isMultiVariant = products.length > 1;
  const ids = products.map(p => String(p._id));
  const slug = (primary.specs?.asin || String(primary._id).slice(-8)).toLowerCase().replace(/[^a-z0-9]/g, '');

  function emit(event, data) { if (io) io.emit(event, { ...data, productIds: ids }); }

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
      const varSlug = slug + (p.variant ? '-' + p.variant.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) : '');
      try {
        const { data } = await axios.post(`${BASE}/api/ebay/upload-images`,
          { imageUrls: varImgs, slug: varSlug }, { timeout: 60000 });
        variantCloudinaryImages.push(data.cloudinaryUrls || []);
        variantCloudinaryFolders.push(`ebay-listings/${varSlug}`);
      } catch {
        variantCloudinaryImages.push(varImgs);
        variantCloudinaryFolders.push(null);
      }
    }
    const allCloudinaryUrls = [...new Set(variantCloudinaryImages.flat())].slice(0, 12);

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
      }, { timeout: 30000 });
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

    const { data: listData } = await axios.post(`${BASE}/api/ebay/trading-create-listing`, payload, { timeout: 60000 });
    const ebayListingId = listData.listingId || listData.itemId;
    if (!ebayListingId) throw new Error('No listing ID returned from eBay');

    // ── 5. Save listing ID + Cloudinary folder to all variants ───────────
    for (let i = 0; i < products.length; i++) {
      await Product.findByIdAndUpdate(products[i]._id, {
        ebayListingId,
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
      const products = await Product.find({ groupId, ebayListingId: null, isPrime: true });
      if (products.length) await autoList(products, io);
      // Refresh frontend so eBay listing IDs appear on cards
      if (io) io.emit('tracker:check:done', { time: new Date().toISOString(), results: [] });
    } catch {}
  }, 180000); // 180s — ScraperAPI takes ~15s per variant; 6 variants = ~90s, 180s gives safe headroom
}

module.exports = { autoList, scheduleGroupAutoList, calcEbayPrice, detectVariantDimension };
