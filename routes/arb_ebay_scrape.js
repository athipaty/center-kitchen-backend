const express = require("express");
const router = express.Router();
const axios = require("axios");
const cheerio = require("cheerio");

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
];

function getHeaders() {
  const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
  return {
    "User-Agent": ua,
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
  };
}

async function getAmazonProduct(url) {
  const asinMatch = url.match(/\/dp\/([A-Z0-9]{10})/);
  if (!asinMatch) {
    throw new Error(
      "Could not find product ID in URL. Make sure it's a direct Amazon product page.",
    );
  }
  const asin = asinMatch[1];
  const cleanUrl = `https://www.amazon.com/dp/${asin}?th=1`;

  const response = await axios.get(cleanUrl, {
    headers: getHeaders(),
    timeout: 15000,
  });

  const $ = cheerio.load(response.data);

  console.log("Amazon status:", response.status);
  console.log("Amazon title:", $("title").text().substring(0, 80));

  if (
    $("title").text().toLowerCase().includes("robot") ||
    $("title").text().toLowerCase().includes("captcha") ||
    response.data.includes("Enter the characters you see below")
  ) {
    throw new Error(
      "Amazon is showing a CAPTCHA. Please try again in a few minutes.",
    );
  }

  const title =
    $("#productTitle").text().trim() ||
    $(".product-title-word-break").text().trim() ||
    null;

  let price = null;
  const priceSelectors = [
    ".priceToPay .a-offscreen",
    ".priceToPay",
    "#priceblock_ourprice",
    "#priceblock_dealprice",
    ".a-price .a-offscreen",
    "#price_inside_buybox",
    ".apexPriceToPay .a-offscreen",
    "#corePrice_feature_div .a-offscreen",
    ".a-price[data-a-size='xl'] .a-offscreen",
  ];

  for (const selector of priceSelectors) {
    const raw = $(selector).first().text().trim();
    if (raw) {
      const match = raw.replace(/,/g, "").match(/[\d.]+/);
      if (match) {
        price = parseFloat(match[0]);
        break;
      }
    }
  }

  const outOfStock =
    $("#availability").text().toLowerCase().includes("unavailable") ||
    $("#availability").text().toLowerCase().includes("out of stock");

  return { title, price, in_stock: !outOfStock };
}

async function searchEbay(query) {
  console.log("Searching Google for eBay listings:", query);

  const searchQuery = `site:ebay.com ${query} buy it now`;
  const encoded = encodeURIComponent(searchQuery);
  const url = `https://www.google.com/search?q=${encoded}&num=20`;

  await new Promise((r) => setTimeout(r, 500));

  const response = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
    },
    timeout: 15000,
    decompress: true,
  });

  const $ = cheerio.load(response.data);
  console.log("Google page title:", $("title").text());

  const listings = [];

  // Google search results
  $("div.g, div[data-sokoban-container]").each((i, el) => {
    if (i > 15) return;

    const linkEl = $(el).find("a").first();
    const itemUrl = linkEl.attr("href") || "";

    // Only eBay item links
    if (!itemUrl.includes("ebay.com/itm")) return;

    const title = $(el).find("h3").text().trim() || linkEl.text().trim() || "";

    if (!title) return;

    // Try to extract price from snippet
    const snippet = $(el).find(".VwiC3b, .yXK7lf, span").text();
    const priceMatch = snippet.replace(/,/g, "").match(/\$[\d.]+/);

    if (!priceMatch) return;
    const price = parseFloat(priceMatch[0].replace("$", ""));
    if (!price || price < 1) return;

    listings.push({
      title: title.replace("Opens in a new window or tab", "").trim(),
      price,
      url: itemUrl,
      condition: "See listing",
      shipping: "See listing",
    });
  });

  console.log("Google/eBay listings found:", listings.length);
  return listings;
}

function getMatchScore(amazonTitle, ebayTitle) {
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "for",
    "with",
    "in",
    "on",
    "at",
    "to",
    "of",
    "is",
    "it",
    "as",
    "be",
    "by",
    "new",
    "item",
    "opens",
    "window",
    "tab",
  ]);

  const tokenize = (text) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

  const amazonWords = tokenize(amazonTitle);
  const ebayWords = new Set(tokenize(ebayTitle));

  if (amazonWords.length === 0) return { score: 0, label: "Low", color: "red" };

  const matched = amazonWords.filter((w) => ebayWords.has(w)).length;
  const score = Math.round((matched / amazonWords.length) * 100);

  let label, color;
  if (score >= 70) {
    label = "High";
    color = "green";
  } else if (score >= 40) {
    label = "Medium";
    color = "amber";
  } else {
    label = "Low";
    color = "red";
  }

  return { score, label, color };
}

router.post("/", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });
  if (!url.includes("amazon.")) {
    return res.status(400).json({ error: "Only Amazon URLs are supported" });
  }

  try {
    const amazon = await getAmazonProduct(url);

    if (!amazon.title) {
      return res.status(400).json({
        error:
          "Could not read Amazon page. Amazon may be blocking the request — try again in 1-2 minutes.",
      });
    }

    if (!amazon.price) {
      return res.status(400).json({
        error:
          "Found the product but could not extract the price. Try a direct product page URL.",
      });
    }

    // Clean query — remove special chars and limit to 4 words
    const shortQuery = amazon.title
      .replace(/[^a-zA-Z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 4)
      .join(" ");
    console.log("eBay search query:", shortQuery);
    const ebayListings = await searchEbay(shortQuery);

    if (!ebayListings.length) {
      return res.status(400).json({
        error: "Could not find this product on eBay.",
      });
    }

    const ebayMin = Math.min(...ebayListings.map((l) => l.price));
    const ebayMax = Math.max(...ebayListings.map((l) => l.price));
    const ebayAvg =
      ebayListings.reduce((s, l) => s + l.price, 0) / ebayListings.length;

    const listingsWithScore = ebayListings.map((listing) => ({
      ...listing,
      match: getMatchScore(amazon.title, listing.title),
    }));

    res.json({
      amazon: {
        title: amazon.title,
        price: amazon.price,
        url,
        in_stock: amazon.in_stock,
      },
      ebay: {
        listings: listingsWithScore,
        lowest_price: ebayMin,
        highest_price: ebayMax,
        average_price: parseFloat(ebayAvg.toFixed(2)),
      },
      summary: {
        profit_if_sell_at_lowest: parseFloat(
          (ebayMin - amazon.price).toFixed(2),
        ),
        profit_if_sell_at_average: parseFloat(
          (ebayAvg - amazon.price).toFixed(2),
        ),
        profit_if_sell_at_highest: parseFloat(
          (ebayMax - amazon.price).toFixed(2),
        ),
        good_deal: ebayMin > amazon.price,
      },
    });
  } catch (err) {
    console.error("Compare error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
