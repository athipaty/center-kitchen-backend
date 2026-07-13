require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');

const BASE = `http://localhost:${process.env.PORT || 5000}`;
const EBAY_FEE  = 0.1325;
const FIXED_FEE = 0.30;
const PROMO     = 0.05;
const MARGIN    = 0.09;
const AMAZON_TAX = 0.085;

function calcEbayPrice(cost) {
  const c = cost * (1 + AMAZON_TAX);
  return Math.floor((c + FIXED_FEE) / (1 - EBAY_FEE - PROMO - MARGIN)) + 0.99;
}

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const Product = require('./models/tracker/Product');

  // Find all active products with no eBay listing
  const unlisted = await Product.find({
    ebayListingId: { $in: [null, undefined] },
    status: { $in: ['active', 'out_of_stock'] },
  }).lean();

  console.log(`\nFound ${unlisted.length} tracked products with no eBay listing\n`);
  unlisted.forEach(p => {
    const profit = calcEbayPrice(p.current) - p.current - (calcEbayPrice(p.current) * EBAY_FEE + FIXED_FEE);
    const ok = p.current < 50 && p.isPrime ? '✓' : '✗';
    console.log(`  ${ok} $${p.current?.toFixed(2)} | prime:${p.isPrime} | ${p.title?.slice(0, 60)}`);
  });

  const eligible = unlisted.filter(p => p.current < 50 && p.isPrime && p.current > 0);
  console.log(`\nEligible to list (Prime + under $50): ${eligible.length}`);

  if (eligible.length === 0) {
    console.log('Nothing to list.');
    return await mongoose.disconnect();
  }

  // Group by groupId (same ASIN = same listing)
  const groups = {};
  for (const p of eligible) {
    const key = p.groupId || String(p._id);
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  }

  console.log(`\nWill create ${Object.keys(groups).length} eBay listing(s)...\n`);

  let created = 0;
  for (const [groupId, variants] of Object.entries(groups)) {
    const primary = variants[0];
    try {
      // Generate SEO title
      let ebayTitle = primary.title;
      try {
        const { data } = await axios.post(`${BASE}/api/ebay/seo-title`,
          { title: primary.title, specs: primary.specs }, { timeout: 20000 });
        if (data.title) ebayTitle = data.title;
      } catch {}

      // Generate description
      let description = null;
      try {
        const { data } = await axios.post(`${BASE}/api/ebay/generate-description`, {
          title: ebayTitle, specs: primary.specs,
          imageUrls: primary.images || [], bullets: primary.bullets || [],
          upc: primary.upc, variant: primary.variant,
        }, { timeout: 30000 });
        description = data.html || null;
      } catch {}

      const isMulti = variants.length > 1;
      const payload = {
        title: ebayTitle,
        price: calcEbayPrice(primary.current).toFixed(2),
        imageUrls: primary.images?.slice(0, 12) || [],
        upc: primary.upc,
        specs: primary.specs || {},
        bullets: primary.bullets || [],
        quantity: 1,
        ...(description ? { description } : {}),
      };

      if (isMulti) {
        payload.variantDimension = 'Style';
        payload.variants = variants.map(v => ({
          label: v.variant || v.title.slice(0, 30),
          price: calcEbayPrice(v.current).toFixed(2),
          quantity: 1,
          images: v.images?.slice(0, 4) || [],
          image: v.image || null,
        }));
      }

      const { data: listData } = await axios.post(
        `${BASE}/api/ebay/trading-create-listing`, payload, { timeout: 60000 }
      );
      const ebayListingId = listData.listingId || listData.itemId;
      if (!ebayListingId) throw new Error('No listing ID returned');

      // Save listing ID back to all variants
      for (const v of variants) {
        await Product.findByIdAndUpdate(v._id, { ebayListingId });
      }

      created++;
      console.log(`✓ Listed "${ebayTitle.slice(0, 60)}" → eBay ${ebayListingId} (${variants.length} variant(s))`);
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      const detail = e.response?.data?.error || e.response?.data || e.message || String(e);
      console.error(`✗ Failed "${primary.title?.slice(0, 50)}": ${detail}`);
    }
  }

  console.log(`\nDone — ${created}/${Object.keys(groups).length} listing(s) created.`);
  await mongoose.disconnect();
}).catch(e => { console.error(e.message); process.exit(1); });
