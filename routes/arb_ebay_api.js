const express = require("express");
const router = express.Router();
const axios = require("axios");

// --- Get eBay OAuth token ---
async function getEbayToken() {
  const credentials = Buffer.from(
    `${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`
  ).toString("base64");

  const response = await axios.post(
    "https://api.ebay.com/identity/v1/oauth2/token",
    "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  return response.data.access_token;
}

// --- Search eBay listings ---
async function searchEbay(query, token, limit = 10) {
  const response = await axios.get(
    "https://api.ebay.com/buy/browse/v1/item_summary/search",
    {
      params: {
        q: query,
        limit,
        filter: "buyingOptions:{FIXED_PRICE}",
        sort: "price",
      },
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
    }
  );
  return response.data.itemSummaries || [];
}

// --- Get eBay item details ---
async function getEbayItemDetails(itemId, token) {
  try {
    const response = await axios.get(
      `https://api.ebay.com/buy/browse/v1/item/${itemId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
      }
    );

    const specifics = {};
    if (response.data.localizedAspects) {
      response.data.localizedAspects.forEach((a) => {
        specifics[a.name] = a.value;
      });
    }

    const availability = response.data.estimatedAvailabilities?.[0];

    return {
      specifics,
      gtin: response.data.gtin || null,
      soldCount: availability?.estimatedSoldQuantity || 0,
      seller: response.data.seller?.username || null,
      sellerFeedback: response.data.seller?.feedbackPercentage || null,
    };
  } catch {
    return { specifics: {}, gtin: null, soldCount: 0, seller: null, sellerFeedback: null };
  }
}

// --- Step B: Build smart search strategy ---
function buildSearchQueries(amazon) {
  const queries = [];

  // Strategy 1: GTIN (most accurate)
  if (amazon.gtin) {
    queries.push({ query: amazon.gtin, strategy: "gtin" });
  }

  // Strategy 2: Brand + Model/MPN
  if (amazon.brand && amazon.model) {
    queries.push({ query: `${amazon.brand} ${amazon.model}`, strategy: "brand_mpn" });
  }

  // Strategy 3: Brand + key title words
  if (amazon.brand) {
    const titleWords = amazon.title
      .replace(/[^a-zA-Z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 4)
      .join(" ");
    queries.push({ query: `${amazon.brand} ${titleWords}`, strategy: "brand_title" });
  }

  // Strategy 4: Normalized title (fallback)
  const genericQuery = amazon.title
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 5)
    .join(" ");
  queries.push({ query: genericQuery, strategy: "title" });

  return queries;
}

// --- Step C: Score each eBay result ---
function scoreEbayResult(amazonProduct, ebayItem, ebayDetails) {
  let score = 0;
  const matchedFields = [];

  const amazonTitle = amazonProduct.title.toLowerCase();
  const ebayTitle = ebayItem.title.toLowerCase();

  // 1. GTIN match (highest confidence +50)
  if (amazonProduct.gtin && ebayDetails.gtin &&
      amazonProduct.gtin === ebayDetails.gtin) {
    score += 50;
    matchedFields.push("GTIN");
  }

  // 2. Brand match (+15)
  if (amazonProduct.brand) {
    const brand = amazonProduct.brand.toLowerCase();
    if (ebayTitle.includes(brand) ||
        ebayDetails.specifics?.["Brand"]?.toLowerCase() === brand) {
      score += 15;
      matchedFields.push("Brand");
    }
  }

  // 3. Model/MPN match (+20)
  if (amazonProduct.model) {
    const model = amazonProduct.model.toLowerCase().replace(/[^a-z0-9]/g, "")
    const ebayTitleClean = ebayTitle.replace(/[^a-z0-9]/g, "")
    const ebayMPN = (ebayDetails.specifics?.["MPN"] || "").toLowerCase().replace(/[^a-z0-9]/g, "")
    if (ebayTitleClean.includes(model) || ebayMPN === model) {
      score += 20;
      matchedFields.push("Model/MPN");
    }
  }

  // 4. Attribute match: color, size, style (+5 each)
  if (amazonProduct.attributes) {
    const attrs = amazonProduct.attributes;
    if (attrs.color) {
      const color = attrs.color.toLowerCase();
      if (ebayTitle.includes(color) ||
          ebayDetails.specifics?.["Color"]?.toLowerCase().includes(color)) {
        score += 5;
        matchedFields.push("Color");
      }
    }
    if (attrs.size) {
      const size = attrs.size.toLowerCase();
      if (ebayTitle.includes(size) ||
          ebayDetails.specifics?.["Size"]?.toLowerCase().includes(size)) {
        score += 5;
        matchedFields.push("Size");
      }
    }
  }

  // 5. Title word overlap (+up to 15)
  const stopWords = new Set(["the","a","an","and","or","for","with","in","on","at","to","of","is","it","new","item"])
  const amazonWords = amazonTitle.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w))
  const ebayWords = new Set(ebayTitle.split(/\s+/).filter(w => w.length > 2))
  const matched = amazonWords.filter(w => ebayWords.has(w))
  const overlapScore = Math.min(15, Math.round((matched.length / Math.max(amazonWords.length, 1)) * 15))
  if (overlapScore > 0) {
    score += overlapScore;
    matchedFields.push(`Title (${matched.length} words)`);
  }

  // Determine confidence level
  let confidence, color;
  if (score >= 70) { confidence = "High"; color = "green"; }
  else if (score >= 40) { confidence = "Medium"; color = "amber"; }
  else { confidence = "Low"; color = "red"; }

  return { score, confidence, color, matchedFields };
}

// --- Main route ---
router.post("/", async (req, res) => {
  const { query, fallback_query, amazon } = req.body;
  if (!query) return res.status(400).json({ error: "Query is required" });

  try {
    const token = await getEbayToken();

    // Step B: Build search strategies
    let items = [];
    let usedStrategy = "title";

    if (amazon) {
      const queries = buildSearchQueries(amazon);
      for (const { query: q, strategy } of queries) {
        console.log(`Trying strategy: ${strategy} → "${q}"`);
        const results = await searchEbay(q, token);
        if (results.length > 0) {
          items = results;
          usedStrategy = strategy;
          console.log(`Found ${results.length} results with strategy: ${strategy}`);
          break;
        }
      }
    } else {
      // Fallback to simple query
      items = await searchEbay(query, token);
      if (!items.length && fallback_query) {
        items = await searchEbay(fallback_query, token);
      }
    }

    if (!items.length) {
      return res.status(400).json({ error: "No eBay listings found for this product." });
    }

    // Build basic listings
    const listings = items.map((item) => ({
      itemId: item.itemId,
      title: item.title,
      price: parseFloat(item.price?.value || 0),
      currency: item.price?.currency || "USD",
      url: item.itemWebUrl,
      condition: item.condition || "Not specified",
      shipping: item.shippingOptions?.[0]?.shippingCost?.value
        ? `$${item.shippingOptions[0].shippingCost.value} shipping`
        : "See listing",
      image: item.image?.imageUrl || null,
      seller: item.seller?.username || null,
      sellerFeedback: item.seller?.feedbackPercentage || null,
      soldCount: 0,
      specifics: {},
      match: { score: 0, confidence: "Low", color: "red", matchedFields: [] },
    }));

    // Fetch details + score for top 5
    for (let i = 0; i < Math.min(5, listings.length); i++) {
      const details = await getEbayItemDetails(listings[i].itemId, token);
      listings[i].specifics = details.specifics;
      listings[i].soldCount = details.soldCount;
      if (!listings[i].seller) listings[i].seller = details.seller;
      if (!listings[i].sellerFeedback) listings[i].sellerFeedback = details.sellerFeedback;

      // Step C: Score
      if (amazon) {
        listings[i].match = scoreEbayResult(amazon, listings[i], details);
      }
    }

    // Step D: Sort by match score
    listings.sort((a, b) => b.match.score - a.match.score);

    // Filter out low confidence if we have enough medium/high
    const goodMatches = listings.filter(l => l.match.score >= 40);
    const finalListings = goodMatches.length >= 3 ? goodMatches : listings;

    console.log(`Strategy used: ${usedStrategy}, Results: ${finalListings.length}`);

    res.json({ listings: finalListings, strategy: usedStrategy });

  } catch (err) {
    console.error("eBay API error:", err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data?.errors?.[0]?.message || err.message,
    });
  }
});

module.exports = { router, searchEbayListings: searchEbay };