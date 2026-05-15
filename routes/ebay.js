const express = require('express');
const router = express.Router();
const axios = require('axios');

router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    const { data } = await axios.get(
      'https://svcs.ebay.com/services/search/FindingService/v1',
      {
        params: {
          'OPERATION-NAME': 'findItemsByKeywords',
          'SERVICE-VERSION': '1.0.0',
          'SECURITY-APPNAME': process.env.EBAY_APP_ID,
          'RESPONSE-DATA-FORMAT': 'JSON',
          keywords: q,
          'paginationInput.entriesPerPage': 12,
          'itemFilter(0).name': 'ListingType',
          'itemFilter(0).value(0)': 'FixedPrice',
          'itemFilter(0).value(1)': 'AuctionWithBIN',
          'sortOrder': 'PricePlusShippingLowest',
        },
      }
    );

    const items =
      data.findItemsByKeywordsResponse?.[0]?.searchResult?.[0]?.item || [];

    const results = items.map(item => ({
      id: item.itemId?.[0],
      title: item.title?.[0],
      price: parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0),
      currency: item.sellingStatus?.[0]?.currentPrice?.[0]?.['@currencyId'] || 'USD',
      image: item.galleryURL?.[0],
      url: item.viewItemURL?.[0],
      condition: item.condition?.[0]?.conditionDisplayName?.[0] || 'Unknown',
      shipping: parseFloat(
        item.shippingInfo?.[0]?.shippingServiceCost?.[0]?.__value__ || 0
      ),
    }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Exact product match by UPC/EAN
router.get('/upc', async (req, res) => {
  const { upc } = req.query;
  if (!upc) return res.status(400).json({ error: 'upc is required' });

  try {
    const { data } = await axios.get(
      'https://svcs.ebay.com/services/search/FindingService/v1',
      {
        params: {
          'OPERATION-NAME': 'findItemsByProduct',
          'SERVICE-VERSION': '1.0.0',
          'SECURITY-APPNAME': process.env.EBAY_APP_ID,
          'RESPONSE-DATA-FORMAT': 'JSON',
          'productId.@type': 'UPC',
          'productId': upc,
          'paginationInput.entriesPerPage': 12,
          'sortOrder': 'PricePlusShippingLowest',
        },
      }
    );

    const items =
      data.findItemsByProductResponse?.[0]?.searchResult?.[0]?.item || [];

    const results = items.map(item => ({
      id: item.itemId?.[0],
      title: item.title?.[0],
      price: parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0),
      currency: item.sellingStatus?.[0]?.currentPrice?.[0]?.['@currencyId'] || 'USD',
      image: item.galleryURL?.[0],
      url: item.viewItemURL?.[0],
      condition: item.condition?.[0]?.conditionDisplayName?.[0] || 'Unknown',
      shipping: parseFloat(
        item.shippingInfo?.[0]?.shippingServiceCost?.[0]?.__value__ || 0
      ),
    }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
