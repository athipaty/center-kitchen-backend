const express = require("express");
const router = express.Router();
const axios = require("axios");

// Get eBay OAuth token using App ID + Cert ID
async function getEbayToken() {
  const credentials = Buffer.from(
    `${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`
  ).toString("base64")

  const response = await axios.post(
    "https://api.ebay.com/identity/v1/oauth2/token",
    "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  )

  return response.data.access_token
}

// Search eBay listings using Browse API
async function searchEbayListings(query) {
  const token = await getEbayToken()

  const response = await axios.get(
    "https://api.ebay.com/buy/browse/v1/item_summary/search",
    {
      params: {
        q: query,
        limit: 10,
        filter: "buyingOptions:{FIXED_PRICE}",
        sort: "price",
      },
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
    }
  )

  const items = response.data.itemSummaries || []

  return items.map((item) => ({
    title: item.title,
    price: parseFloat(item.price?.value || 0),
    currency: item.price?.currency || "USD",
    url: item.itemWebUrl,
    condition: item.condition || "Not specified",
    shipping: item.shippingOptions?.[0]?.shippingCost?.value
      ? `$${item.shippingOptions[0].shippingCost.value} shipping`
      : "See listing",
    image: item.image?.imageUrl || null,
  }))
}

// POST /api/ebay-search
// Body: { query: "product name" }
router.post("/", async (req, res) => {
  const { query } = req.body
  if (!query) return res.status(400).json({ error: "Query is required" })

  try {
    const listings = await searchEbayListings(query)

    if (!listings.length) {
      return res.status(400).json({
        error: "No eBay listings found for this product.",
      })
    }

    res.json({ listings })
  } catch (err) {
    console.error("eBay API error:", err.response?.data || err.message)
    res.status(500).json({
      error: err.response?.data?.errors?.[0]?.message || err.message,
    })
  }
})

module.exports = router