const axios   = require('axios');
const cheerio = require('cheerio');
const Product = require('../models/tracker/Product');
const TrackerSettings = require('../models/tracker/TrackerSettings');
const { fetchProduct, extractAsin } = require('../scraper');

const { calcEbayPrice, detectVariantDimension } = require('./autoList');

const EBAY_FEE = 0.1325, FIXED_FEE = 0.30;

function calcProfit(cost, saleMode) {
  const cp = calcEbayPrice(cost, saleMode);
  return +(cp - cost - (cp * EBAY_FEE + FIXED_FEE)).toFixed(2);
}

// Returns the 5 most meaningful words from a product title (used for similarity check)
function titleFingerprint(title) {
  const stop = new Set([
    'the','a','an','and','or','for','with','set','pack','count','piece','pcs',
    'new','inch','inches','large','small','medium','heavy','duty','high','quality',
    'premium','men','women','boys','girls','kids','adults','ideal','perfect','best',
    'ultra','super','pro','plus','mini','max','great','good','top','pack','value',
  ]);
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stop.has(w) && !/^\d+$/.test(w))
    .slice(0, 5);
}

// Returns true if candidateTitle shares 2+ key words with any existing product title
function isTooSimilar(candidateTitle, existingProducts) {
  const cWords = new Set(titleFingerprint(candidateTitle));
  for (const p of existingProducts) {
    if (!p.title) continue;
    const eWords = titleFingerprint(p.title);
    const overlap = eWords.filter(w => cWords.has(w)).length;
    if (overlap >= 2) return true;
  }
  return false;
}

// Map Amazon top-level BSR category names → Amazon new-releases URL slugs
const CATEGORY_SLUG_MAP = {
  'kitchen & dining':          'kitchen',
  'home & kitchen':            'kitchen',
  'kitchen':                   'kitchen',
  'tools & home improvement':  'tools',
  'tools':                     'tools',
  'sports & outdoors':         'sports-outdoors',
  'sports':                    'sports-outdoors',
  'home & garden':             'home-garden',
  'garden & outdoor':          'lawn-garden',
  'patio, lawn & garden':      'lawn-garden',
  'electronics':               'electronics',
  'beauty & personal care':    'beauty',
  'beauty':                    'beauty',
  'baby':                      'baby',
  'toys & games':              'toys-and-games',
  'office products':           'office-products',
  'clothing, shoes & jewelry': 'clothing-shoes-jewelry',
  'health & household':        'hpc',
  'grocery & gourmet food':    'grocery',
  'pet supplies':              'pets',
  'automotive':                'automotive',
};

function extractCategorySlug(product) {
  const bsr = product.specs?.best_sellers_rank;
  if (!Array.isArray(bsr) || !bsr.length) return null;
  // BSR entry example: "#183 in Tools & Home Improvement (See Top 100 ...)"
  // Take only the top-level category (first entry in the array, broadest one)
  for (const entry of bsr) {
    const match = String(entry).match(/in\s+([A-Za-z,&' ]+?)(?:\s*\(|$)/i);
    if (!match) continue;
    const raw = match[1].trim().toLowerCase();
    // Exact match
    if (CATEGORY_SLUG_MAP[raw]) return CATEGORY_SLUG_MAP[raw];
    // Partial match
    for (const [key, slug] of Object.entries(CATEGORY_SLUG_MAP)) {
      if (raw.includes(key) || key.includes(raw)) return slug;
    }
  }
  return null;
}

// 1 credit: scrape the new-releases page and extract ASIN + rating + reviews + price
// so we can pre-filter before spending 5-credit structured calls.
async function fetchNewReleaseCandidates(categorySlug, scraperKey, seenAsins) {
  const url = `https://www.amazon.com/gp/new-releases/${categorySlug}/`;
  try {
    const { data: html } = await axios.get('https://api.scraperapi.com/', {
      params: { api_key: scraperKey, url },
      timeout: 30000,
    });
    const $ = cheerio.load(html);
    const seen = new Set();
    const candidates = [];

    $('[data-asin]').each((_, el) => {
      const asin = $(el).attr('data-asin');
      if (!asin || asin.length !== 10 || seen.has(asin) || seenAsins.has(asin)) return;
      seen.add(asin);

      const ratingText = $(el).find('.a-icon-alt').first().text();
      const rating = parseFloat(ratingText) || 0;

      const reviewEl = $(el).find('[aria-label]').filter((_, e) => /^\d[\d,]*$/.test($(e).attr('aria-label') || '')).first();
      const reviewCount = parseInt((reviewEl.attr('aria-label') || '0').replace(/,/g, '')) || 0;

      const whole    = $(el).find('.a-price-whole').first().text().replace(/[^0-9]/g, '');
      const fraction = $(el).find('.a-price-fraction').first().text().replace(/[^0-9]/g, '') || '00';
      const price    = whole ? parseFloat(`${whole}.${fraction}`) : 0;

      candidates.push({ asin, rating, reviewCount, price });
    });

    // Fallback: if CSS selector found nothing, extract ASINs from href patterns
    if (!candidates.length) {
      const asinMatches = [...html.matchAll(/\/dp\/([A-Z0-9]{10})/g)].map(m => m[1]);
      const unique = [...new Set(asinMatches)].filter(a => !seenAsins.has(a));
      console.log(`productDiscovery: new-releases/${categorySlug} — [data-asin] found 0, regex fallback found ${unique.length} ASINs`);
      unique.slice(0, 24).forEach(asin => candidates.push({ asin, rating: 0, reviewCount: 0, price: 0 }));
    }

    // Pre-filter by criteria we already know — saves 5-credit structured calls
    const preFiltered = candidates.filter(c =>
      (c.rating === 0 || c.rating >= 4) &&
      (c.reviewCount === 0 || c.reviewCount >= 50) &&
      (c.price === 0 || c.price < 50)
    );

    const dropped = candidates.length - preFiltered.length;
    console.log(`productDiscovery: new-releases/${categorySlug} → ${candidates.length} ASINs, ${dropped} pre-filtered (saved ${dropped * 5} credits)`);
    return preFiltered.slice(0, 24);
  } catch (e) {
    console.error(`productDiscovery: failed to fetch new-releases/${categorySlug}:`, e.message);
    return [];
  }
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

async function fetchSimilarAsins(product, scraperKey) {
  const query = titleKeywords(product.title);
  if (!query) return [];
  try {
    const { data } = await axios.get('https://api.scraperapi.com/structured/amazon/search/v1', {
      params: { api_key: scraperKey, query, country: 'us' },
      timeout: 30000,
    });
    const results = data.results || data.organic_results || data.products || [];
    const filtered = results.filter(r => {
      const rating = parseFloat(r.rating || r.average_rating) || 0;
      const reviews = parseInt(r.reviews_count || r.total_ratings || r.ratings_total) || 0;
      if (rating > 0 && rating < 4) return false;
      if (reviews > 0 && reviews < 50) return false;
      return true;
    });
    const asins = filtered
      .map(r => r.asin || extractAsin(r.url || r.link || ''))
      .filter(Boolean);
    console.log(`productDiscovery: search "${query}" → ${asins.length} ASINs (${results.length - filtered.length} filtered by rating/reviews)`);
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
    const viewed = Object.values(byListing)
      .filter(x => x.views > 0)
      .sort((a, b) => b.views - a.views)
      .slice(0, 10)
      .map(x => x.product);

    // Fall back to a random sample of all listed products when none have views yet
    const topProducts = viewed.length
      ? viewed
      : listedProducts.sort(() => Math.random() - 0.5).slice(0, 10);

    if (!topProducts.length) {
      console.log('productDiscovery: no listed products to base search on');
      return;
    }
    console.log('productDiscovery: seeds:', topProducts.map(p =>
      `"${p.title.slice(0, 40)}" (${views[p.ebayListingId] ?? 0}v)`));

    // ── 2. Find new release ASINs in the same categories as top products ─────
    const existingAsins = new Set(allProducts.map(p => p.groupId).filter(Boolean));
    const candidates = [];
    const seenAsins = new Set(existingAsins);
    const seenCategories = new Set();

    for (const source of topProducts) {
      if (candidates.length >= Math.max(slotsToFill * 5, 20)) break;
      const slug = extractCategorySlug(source);
      if (!slug || seenCategories.has(slug)) continue;
      seenCategories.add(slug);
      console.log(`productDiscovery: seed "${source.title.slice(0, 40)}" → category "${slug}"`);
      const newReleaseCandidates = await fetchNewReleaseCandidates(slug, scraperKey, seenAsins);
      for (const c of newReleaseCandidates) {
        seenAsins.add(c.asin);
        candidates.push({ ...c, sourceTitle: source.title, category: slug, fromNewReleasePage: true });
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    // Fallback: if no categories detected in BSR data, use keyword search
    if (!candidates.length) {
      console.log('productDiscovery: no category BSR data found, falling back to keyword search');
      for (const source of topProducts) {
        if (candidates.length >= Math.max(slotsToFill * 5, 20)) break;
        const similarAsins = await fetchSimilarAsins(source, scraperKey);
        for (const asin of similarAsins) {
          if (!seenAsins.has(asin)) {
            seenAsins.add(asin);
            candidates.push({ asin, sourceTitle: source.title });
          }
        }
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    console.log(`productDiscovery: ${candidates.length} candidate ASINs to evaluate`);
    if (!candidates.length) return;

    // ── 3. Fetch product info + score by profit ───────────────────────────
    // qualified = [{ asin, url, info, baseProfit, variantsToAdd }]
    // variantsToAdd = resolved list of variants (or single-product treated as 1 variant)
    const qualified = [];

    for (const { asin, rating: preRating, reviewCount: preReviews, price: prePrice, fromNewReleasePage } of candidates) {
      if (qualified.length >= Math.max(slotsToFill * 3, 5)) break; // enough candidates, stop scraping

      // Skip structured fetch (5 credits) if pre-filter data already disqualifies
      if (preRating  > 0 && preRating  < 4)  continue;
      if (preReviews > 0 && preReviews < 50)  continue;
      if (prePrice   > 0 && prePrice   >= 50) continue;

      try {
        const url = `https://www.amazon.com/dp/${asin}`;
        const info = await fetchProduct(url, { priceOnly: false });
        if (!info.price || !info.isPrime) continue;
        if (!info.rating || info.rating < 4) continue;
        if (!info.reviewCount || info.reviewCount < 50) continue;
        if (info.title && isTooSimilar(info.title, allProducts)) {
          console.log(`productDiscovery: skipping ${asin} "${info.title.slice(0,50)}" — too similar to existing product`);
          continue;
        }

        const variants = info.variants?.filter(v => v.asin) || [];

        if (variants.length === 0) {
          // Single product — 1 slot, use base price
          if (info.price >= 50) continue; // only source products costing under $50
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
          if (info.price >= 50) continue; // only source products costing under $50
          const baseProfit = calcProfit(info.price, saleMode);
          if (baseProfit <= 0) continue;
          qualified.push({ asin, url, info, baseProfit, variantsToAdd: variantList });
        }

        console.log(`productDiscovery: qualified ${asin} — ${info.variants?.length || 0} variant(s), baseProfit=$${calcProfit(info.price, saleMode)}, rating=${info.rating}, reviews=${info.reviewCount}, newRelease=${info.isNewRelease}`);
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

    const { autoList } = require('./autoList');

    for (const { asin, info, variantsToAdd } of toProcess) {
      try {
        const scheduler = require('./trackerScheduler');

        // Save each variant as a Product document
        const savedProducts = [];
        for (const v of variantsToAdd) {
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
            groupId: asin,
            specs: info.specs || {},
            bullets: info.bullets || [],
          });
          scheduler.scheduleNew(product);
          await product.save();
          savedProducts.push(product);
        }

        // Full listing pipeline (images → title → description → eBay → photos)
        const ebayListingId = await autoList(savedProducts, io);
        if (!ebayListingId) throw new Error('No listing ID returned');

        const profit = calcProfit(info.price, saleMode);
        added.push({ asin, title: info.title, profit, ebayListingId, variantCount: variantsToAdd.length });
        console.log(`productDiscovery: ✓ ${asin} → eBay ${ebayListingId} (${variantsToAdd.length} variant(s), +$${profit})`);
        if (io) io.emit('tracker:discovery:added', { asin, title: info.title, ebayListingId, profit });

        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        const detail = e.response?.data?.error || e.response?.data || e.message || String(e);
        console.error(`productDiscovery: failed to add ${asin}:`, detail);
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
  } finally {
    // Always stamp the run time so the UI/monitor can tell it completed
    await TrackerSettings.findByIdAndUpdate('tracker',
      { $set: { lastDiscoveryRun: new Date() } },
      { upsert: true }
    ).catch(() => {});
  }
}

module.exports = { runProductDiscovery };
