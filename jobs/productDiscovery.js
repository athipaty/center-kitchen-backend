const axios = require('axios');
const Product = require('../models/tracker/Product');
const TrackerSettings = require('../models/tracker/TrackerSettings');
const { fetchProduct, extractAsin } = require('../scraper');

const BASE = `http://localhost:${process.env.PORT || 5000}`;

const EBAY_FEE   = 0.1325;
const FIXED_FEE  = 0.30;
const PROMO      = 0.05;
const MIN_PROFIT = 4.50;

function calcEbayPrice(cost, saleMode) {
  if (saleMode) {
    return Math.floor((cost + FIXED_FEE) / (1 - EBAY_FEE - PROMO - 0.02)) + 0.99;
  }
  const m      = cost < 10 ? 2.2 : cost < 20 ? 1.7 : cost < 35 ? 1.55 : cost < 60 ? 1.45 : 1.35;
  const tiered = cost * m;
  const floor  = (cost + MIN_PROFIT + FIXED_FEE) / (1 - EBAY_FEE);
  return Math.floor(Math.max(tiered, floor)) + 0.99;
}

function calcProfit(cost, saleMode) {
  const cp = calcEbayPrice(cost, saleMode);
  return +(cp - cost - (cp * EBAY_FEE + FIXED_FEE)).toFixed(2);
}

function titleKeywords(title) {
  const stop = new Set(['the','a','an','and','or','for','with','set','pack','count',
    'piece','pcs','new','inch','inches','black','white','gray','blue','red','green',
    'large','small','medium','heavy','duty','high','quality','premium']);
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stop.has(w) && !/^\d+$/.test(w))
    .slice(0, 4)
    .join(' ');
}

function detectVariantDimension(variants) {
  if (variants.some(v => (v.label || '').match(/\d+["'\s]*(inch|in\b|cm\b|mm\b|oz\b|lb\b|ft\b)/i))) return 'Size';
  if (variants.some(v => (v.label || '').match(/\b(red|blue|green|black|white|gray|grey|pink|purple|yellow|orange|brown|natural|carbonized|silver|gold|beige|navy|teal)\b/i))) return 'Color';
  return 'Style';
}

async function fetchSimilarAsins(product, scraperKey) {
  const query = titleKeywords(product.title);
  if (!query) return [];
  try {
    const { data } = await axios.get('https://api.scraperapi.com/structured/amazon/search/v1', {
      params: { api_key: scraperKey, query, country: 'us' },
      timeout: 30000,
    });
    const results = data.results || data.organic_results || data.products || [];
    const asins = results
      .map(r => r.asin || extractAsin(r.url || r.link || ''))
      .filter(Boolean);
    console.log(`productDiscovery: search "${query}" → ${asins.length} ASINs`);
    return asins.slice(0, 20);
  } catch (e) {
    console.error(`productDiscovery: search failed for "${query}":`, e.message);
    return [];
  }
}

async function fetchEbayViews(listingIds, token) {
  if (!listingIds.length) return {};
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const { data } = await axios.get('https://api.ebay.com/sell/analytics/v1/traffic_report', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        dimension: 'LISTING',
        metric: 'LISTING_VIEWS_TOTAL',
        filter: `listing_ids:{${listingIds.join('|')}},date_range:[${fmt(start)}..${fmt(now)}]`,
      },
      timeout: 20000,
    });
    const views = {};
    for (const rec of (data.records || [])) {
      const lid = String(rec.dimensionValues?.[0]?.value || '');
      if (lid) views[lid] = Number(rec.metricValues?.[0]?.value ?? 0);
    }
    return views;
  } catch (e) {
    console.error('productDiscovery: view fetch failed:', e.message);
    return {};
  }
}

// slotsToFill comes directly from the delete job — no selling-limits API call needed.
// Each variant counts as 1 slot. Multi-variant products are trimmed to fit remaining slots.
async function runProductDiscovery(io, slotsToFill) {
  if (!slotsToFill || slotsToFill <= 0) {
    console.log('productDiscovery: 0 slots freed, skipping');
    return;
  }

  const scraperKey = process.env.SCRAPER_API_KEY;
  if (!scraperKey) {
    console.log('productDiscovery: no SCRAPER_API_KEY, skipping');
    return;
  }

  console.log(`productDiscovery: starting — ${slotsToFill} slot(s) to fill`);

  try {
    const settings = await TrackerSettings.findById('tracker').lean().catch(() => null);
    const saleMode = settings?.saleModeActive ?? false;

    // ── 1. Get top-viewed listings ────────────────────────────────────────
    const { getAccessToken } = require('./ebayPriceSync');
    const token = await getAccessToken();

    const allProducts = await Product.find({}).lean();
    const listedProducts = allProducts.filter(p => p.ebayListingId);
    if (!listedProducts.length) return;

    const listingIds = [...new Set(listedProducts.map(p => String(p.ebayListingId)))];
    const views = await fetchEbayViews(listingIds, token);

    const byListing = {};
    for (const p of listedProducts) {
      const lid = String(p.ebayListingId);
      if (!byListing[lid]) byListing[lid] = { product: p, views: views[lid] || 0 };
    }
    const topProducts = Object.values(byListing)
      .filter(x => x.views > 0)
      .sort((a, b) => b.views - a.views)
      .slice(0, 5)
      .map(x => x.product);

    if (!topProducts.length) {
      console.log('productDiscovery: no viewed listings to base search on');
      return;
    }
    console.log('productDiscovery: top products:', topProducts.map(p =>
      `"${p.title.slice(0, 40)}" (${views[p.ebayListingId]}v)`));

    // ── 2. Find similar ASINs ─────────────────────────────────────────────
    const existingAsins = new Set(allProducts.map(p => p.asin).filter(Boolean));
    const candidates = [];
    const seenAsins = new Set(existingAsins);

    for (const source of topProducts) {
      if (candidates.length >= slotsToFill * 5) break; // gather plenty to evaluate
      const similarAsins = await fetchSimilarAsins(source, scraperKey);
      for (const asin of similarAsins) {
        if (!seenAsins.has(asin)) {
          seenAsins.add(asin);
          candidates.push({ asin, sourceTitle: source.title });
        }
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    console.log(`productDiscovery: ${candidates.length} candidate ASINs to evaluate`);
    if (!candidates.length) return;

    // ── 3. Fetch product info + score by profit ───────────────────────────
    // qualified = [{ asin, url, info, baseProfit, variantsToAdd }]
    // variantsToAdd = resolved list of variants (or single-product treated as 1 variant)
    const qualified = [];

    for (const { asin } of candidates) {
      if (qualified.length >= slotsToFill * 3) break; // enough candidates, stop scraping
      try {
        const url = `https://www.amazon.com/dp/${asin}`;
        const info = await fetchProduct(url, { priceOnly: false });
        if (!info.price || !info.isPrime) continue;

        const variants = info.variants?.filter(v => v.asin) || [];

        if (variants.length === 0) {
          // Single product — 1 slot, use base price
          const profit = calcProfit(info.price, saleMode);
          if (profit <= 0) continue;
          qualified.push({
            asin, url, info, baseProfit: profit,
            variantsToAdd: [{ asin, url, label: null, price: info.price, image: info.image, images: info.images }],
          });
        } else {
          // Multi-variant — each variant = 1 slot
          // Use base price for all variants (individual prices fetched lazily below if needed)
          const variantList = variants.map(v => ({
            asin: v.asin,
            url: `https://www.amazon.com/dp/${v.asin}`,
            label: v.label,
            price: v.price || info.price, // prefer per-variant price, fall back to base
            image: v.image || info.image,
            images: v.image ? [v.image, ...(info.images || [])] : (info.images || []),
          }));
          const baseProfit = calcProfit(info.price, saleMode);
          if (baseProfit <= 0) continue;
          qualified.push({ asin, url, info, baseProfit, variantsToAdd: variantList });
        }

        console.log(`productDiscovery: qualified ${asin} — ${info.variants?.length || 0} variant(s), baseProfit=$${calcProfit(info.price, saleMode)}`);
        await new Promise(r => setTimeout(r, 800));
      } catch {
        // skip out-of-stock, unavailable, etc.
      }
    }

    if (!qualified.length) {
      console.log('productDiscovery: no profitable candidates found');
      return;
    }

    // Sort by base profit descending
    qualified.sort((a, b) => b.baseProfit - a.baseProfit);

    // ── 4. Fill slots — each variant = 1 slot, cap + trim per product ────────
    // Cap at 3 variants per product to spread slots across more products
    // (2 listings in different niches = 2x search visibility vs 6 variants of 1 listing)
    const MAX_VARIANTS_PER_PRODUCT = 3;
    const toProcess = [];
    let slotsRemaining = slotsToFill;

    for (const candidate of qualified) {
      if (slotsRemaining <= 0) break;
      const capped   = candidate.variantsToAdd.slice(0, MAX_VARIANTS_PER_PRODUCT);
      const trimmed  = capped.slice(0, slotsRemaining);
      toProcess.push({ ...candidate, variantsToAdd: trimmed });
      slotsRemaining -= trimmed.length;
      console.log(`productDiscovery: plan ${candidate.asin} — ${trimmed.length}/${candidate.variantsToAdd.length} variant(s) (cap ${MAX_VARIANTS_PER_PRODUCT}), slots left: ${slotsRemaining}`);
    }

    console.log(`productDiscovery: adding ${toProcess.length} product(s), filling ${slotsToFill - slotsRemaining} slot(s)`);

    // ── 5. Add each product to tracker + auto-list on eBay ────────────────
    const added = [];

    for (const { asin, info, variantsToAdd } of toProcess) {
      try {
        const isMultiVariant = variantsToAdd.length > 1 || (info.variants?.length > 0);
        const slug = asin.toLowerCase();

        // Save each variant as a Product document
        const savedProducts = [];
        for (const v of variantsToAdd) {
          const variantSlug = slug + (v.label ? '-' + v.label.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) : '');
          const product = new Product({
            url: v.url,
            title: info.title,
            image: v.image || null,
            images: [...new Set([v.image, ...(v.images || [])].filter(Boolean))],
            upc: info.upc || null,
            currency: info.currency,
            current: v.price,
            lowest: v.price,
            history: [{ price: v.price }],
            isPrime: true,
            variant: v.label || info.variant || null,
            groupId: asin, // group all variants under the base ASIN
            specs: info.specs || {},
            bullets: info.bullets || [],
          });
          const scheduler = require('./trackerScheduler');
          scheduler.scheduleNew(product);
          await product.save();
          savedProducts.push({ product, variantSlug, v });
        }

        // Upload images per variant to Cloudinary
        const variantCloudinaryImages = [];
        const variantCloudinaryFolders = [];
        for (const { product, variantSlug, v } of savedProducts) {
          const varImgs = [...new Set([v.image, ...(v.images || [])].filter(Boolean))].slice(0, 8);
          if (!varImgs.length) { variantCloudinaryImages.push([]); variantCloudinaryFolders.push(null); continue; }
          try {
            const { data: uploadData } = await axios.post(`${BASE}/api/ebay/upload-images`, {
              imageUrls: varImgs, slug: variantSlug,
            }, { timeout: 60000 });
            variantCloudinaryImages.push(uploadData.cloudinaryUrls || []);
            variantCloudinaryFolders.push(`ebay-listings/${variantSlug}`);
          } catch {
            variantCloudinaryImages.push(varImgs);
            variantCloudinaryFolders.push(null);
          }
        }

        const allCloudinaryUrls = [...new Set(variantCloudinaryImages.flat())].slice(0, 12);

        // Generate SEO title
        let ebayTitle = info.title;
        try {
          const { data: titleData } = await axios.post(`${BASE}/api/ebay/seo-title`, {
            title: info.title, specs: info.specs,
          }, { timeout: 20000 });
          if (titleData.title) ebayTitle = titleData.title;
        } catch {}

        // Generate HTML description
        let description = null;
        try {
          const { data: descData } = await axios.post(`${BASE}/api/ebay/generate-description`, {
            title: ebayTitle, specs: info.specs,
            imageUrls: allCloudinaryUrls, bullets: info.bullets || [],
            upc: info.upc, variant: info.variant,
          }, { timeout: 30000 });
          description = descData.html || null;
        } catch {}

        // Build listing payload
        const listingPayload = {
          title: ebayTitle,
          price: calcEbayPrice(info.price, saleMode).toFixed(2),
          imageUrls: allCloudinaryUrls,
          upc: info.upc,
          specs: info.specs || {},
          bullets: info.bullets || [],
          quantity: 1,
          ...(description ? { description } : {}),
        };

        // Add variant array for multi-variation listings
        if (isMultiVariant && variantsToAdd.length > 1) {
          listingPayload.variantDimension = detectVariantDimension(variantsToAdd);
          listingPayload.variants = variantsToAdd.map((v, i) => ({
            label: v.label || `Variant ${i + 1}`,
            price: calcEbayPrice(v.price, saleMode).toFixed(2),
            quantity: 1,
            images: variantCloudinaryImages[i] || [],
            image: variantCloudinaryImages[i]?.[0] || null,
          }));
        }

        // Create eBay listing
        const { data: listData } = await axios.post(`${BASE}/api/ebay/trading-create-listing`,
          listingPayload, { timeout: 60000 });

        const ebayListingId = listData.listingId || listData.itemId;
        if (!ebayListingId) throw new Error('No listing ID returned');

        // Save listing ID to all variant products
        for (let i = 0; i < savedProducts.length; i++) {
          await Product.findByIdAndUpdate(savedProducts[i].product._id, {
            ebayListingId,
            cloudinaryFolder: variantCloudinaryFolders[i] || null,
          });
        }

        const profit = calcProfit(info.price, saleMode);
        added.push({ asin, title: info.title, profit, ebayListingId, variantCount: variantsToAdd.length });
        console.log(`productDiscovery: ✓ ${asin} → eBay ${ebayListingId} (${variantsToAdd.length} variant(s), +$${profit})`);
        if (io) io.emit('tracker:discovery:added', { asin, title: info.title, ebayListingId, profit });

        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        console.error(`productDiscovery: failed to add ${asin}:`, e.message);
      }
    }

    // ── 6. Store results for morning banner ───────────────────────────────
    await TrackerSettings.findByIdAndUpdate('tracker',
      { $set: { lastDiscoveryRun: new Date(), lastDiscoveryAdded: added } },
      { upsert: true }
    );

    console.log(`productDiscovery: done — ${added.length} listing(s) created`);
    if (io) io.emit('tracker:discovery:done', { added });

  } catch (e) {
    console.error('productDiscovery: fatal error:', e.message);
  }
}

module.exports = { runProductDiscovery };
