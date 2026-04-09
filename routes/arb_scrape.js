const express = require("express");
const router = express.Router();
const axios = require("axios");
const cheerio = require("cheerio");

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
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

router.post("/", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });
  if (!url.includes("amazon.")) {
    return res.status(400).json({ error: "Only Amazon URLs are supported" });
  }

  try {
    // Extract ASIN and build clean URL
    const asinMatch = url.match(/\/dp\/([A-Z0-9]{10})/);
    if (!asinMatch) {
      return res.status(400).json({
        error:
          "Could not find product ID in URL. Make sure it's a direct Amazon product page.",
      });
    }
    const asin = asinMatch[1];

    // Keep original variant params from URL
    let variantParams = "th=1";
    try {
      const urlObj = new URL(url);
      const th = urlObj.searchParams.get("th");
      const psc = urlObj.searchParams.get("psc");
      const params = [];
      if (th) params.push(`th=${th}`);
      if (psc) params.push(`psc=${psc}`);
      if (params.length) variantParams = params.join("&");
    } catch {}

    const cleanUrl = `https://www.amazon.com/dp/${asin}?${variantParams}`;
    console.log("Fetching Amazon URL:", cleanUrl);

    const response = await axios.get(cleanUrl, {
      headers: getHeaders(),
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);

    // Check for CAPTCHAF
    if (
      $("title").text().toLowerCase().includes("robot") ||
      $("title").text().toLowerCase().includes("captcha") ||
      response.data.includes("Enter the characters you see below")
    ) {
      return res.status(400).json({
        error:
          "Amazon is showing a CAPTCHA. Please try again in a few minutes.",
      });
    }

    // --- TITLE ---
    const title =
      $("#productTitle").text().trim() ||
      $(".product-title-word-break").text().trim() ||
      null;

    if (!title) {
      return res.status(400).json({
        error: "Could not read Amazon page. Try again in a moment.",
      });
    }

    // --- PRICE ---
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

    // --- STOCK ---
    const outOfStock =
      $("#availability").text().toLowerCase().includes("unavailable") ||
      $("#availability").text().toLowerCase().includes("out of stock");

    // Check Prime eligibility
    const isPrime =
      $(".a-icon-prime").length > 0 ||
      $("#isPrime").length > 0 ||
      $("[aria-label='Amazon Prime']").length > 0 ||
      $(".prime-logo").length > 0 ||
      $("[data-csa-c-type='PRIME']").length > 0 ||
      response.data.includes("a-icon-prime") ||
      response.data.includes('"isPrime":true') ||
      response.data.includes('primeEligible":true') ||
      response.data.includes("FREE delivery") ||
      response.data.includes("prime-logo") ||
      response.data.toLowerCase().includes("fulfilled by amazon");

    // --- BRAND ---
    const brand =
      $("#bylineInfo")
        .text()
        .replace("Brand:", "")
        .replace("Visit the", "")
        .replace("Store", "")
        .trim() ||
      $("#brand").text().trim() ||
      null;

    // Rating and reviews
    const rating =
      $("#acrPopover").attr("title")?.replace("out of 5 stars", "").trim() ||
      $(".a-icon-star .a-icon-alt")
        .first()
        .text()
        .replace("out of 5 stars", "")
        .trim() ||
      null;

    const reviewCount =
      $("#acrCustomerReviewText")
        .first()
        .text()
        .replace(/[^0-9,]/g, "")
        .replace(",", "") || null;

    // Bought last month
    const boughtLastMonth =
      $("#social-proofing-faceout-title-tk_bought").text().trim() ||
      $(".social-proofing-faceout-title").text().trim() ||
      null;

    // --- MODEL ---
    let model = null;
    $(
      "#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr",
    ).each((i, el) => {
      const label = $(el).find("th, td").first().text().toLowerCase();
      if (label.includes("model") || label.includes("item model")) {
        model = $(el).find("td").last().text().trim();
      }
    });
    if (!model) {
      $("#detailBullets_feature_div li").each((i, el) => {
        const text = $(el).text();
        if (text.toLowerCase().includes("model number")) {
          model = text.split(":")[1]?.trim() || null;
        }
      });
    }

    // --- GTIN (barcode) ---
    let gtin = null;
    $("#detailBullets_feature_div li").each((i, el) => {
      const text = $(el)
        .text()
        .replace(/[\n\r\t]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (
        text.toLowerCase().includes("upc") ||
        text.toLowerCase().includes("ean")
      ) {
        const parts = text.split(":");
        if (parts[1]) gtin = parts[1].replace(/[\u200e\u200f]/g, "").trim();
      }
    });
    // Also check tech spec table
    if (!gtin) {
      $("#productDetails_techSpec_section_1 tr").each((i, el) => {
        const key = $(el).find("th").text().toLowerCase();
        if (
          key.includes("upc") ||
          key.includes("ean") ||
          key.includes("gtin")
        ) {
          gtin = $(el)
            .find("td")
            .text()
            .replace(/[\u200e\u200f\n\r\t]/g, "")
            .trim();
        }
      });
    }

    // --- BULLETS ---
    const bullets = [];
    $("#feature-bullets ul li span.a-list-item").each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 10 && text.length < 300) {
        bullets.push(text);
      }
    });

    // --- IMAGE ---
    let image = null;
    const imgSelectors = [
      "#landingImage",
      "#imgBlkFront",
      "#ebooksImgBlkFront",
      ".a-dynamic-image",
    ];
    for (const sel of imgSelectors) {
      const src =
        $(sel).attr("data-old-hires") ||
        $(sel).attr("data-a-dynamic-image") ||
        $(sel).attr("src");
      if (src) {
        if (src.startsWith("{")) {
          try {
            const urls = Object.keys(JSON.parse(src));
            if (urls.length) {
              image = urls[0];
              break;
            }
          } catch {}
        } else {
          image = src;
          break;
        }
      }
    }

    // --- PRODUCT DETAILS TABLE ---
    const details = {};

    // Format 1 — tech specs table
    $(
      "#productDetails_techSpec_section_1 tr, #productDetails_techSpec_section_2 tr",
    ).each((i, el) => {
      const key = $(el)
        .find("th")
        .text()
        .replace(/[\n\r\t]/g, "")
        .trim();
      const value = $(el)
        .find("td")
        .text()
        .replace(/[\n\r\t\u200e\u200f]/g, "")
        .trim();
      if (key && value && key.length < 60 && value.length < 150) {
        details[key] = value;
      }
    });

    // Format 2 — detail bullets sections
    $(
      "#productDetails_detailBullets_sections1 tr, #productDetails_detailBullets_sections2 tr",
    ).each((i, el) => {
      const key = $(el)
        .find("th")
        .text()
        .replace(/[\n\r\t]/g, "")
        .trim();
      const value = $(el)
        .find("td")
        .text()
        .replace(/[\n\r\t\u200e\u200f]/g, "")
        .trim();
      if (key && value && key.length < 60 && value.length < 150) {
        details[key] = value;
      }
    });

    // Format 3 — detail bullets list
    $("#detailBullets_feature_div li").each((i, el) => {
      const text = $(el)
        .text()
        .replace(/[\n\r\t]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const colonIdx = text.indexOf(":");
      if (colonIdx > 0) {
        const key = text
          .substring(0, colonIdx)
          .replace(/[\u200e\u200f]/g, "")
          .trim();
        const value = text
          .substring(colonIdx + 1)
          .replace(/[\u200e\u200f]/g, "")
          .trim();
        if (key && value && key.length < 60 && value.length < 150) {
          details[key] = value;
        }
      }
    });

    // Format 4 — prodDetTable (older Amazon layout)
    $(".prodDetTable tr").each((i, el) => {
      const key = $(el)
        .find(".prodDetSectionEntry")
        .text()
        .replace(/[\n\r\t]/g, "")
        .trim();
      const value = $(el)
        .find(".prodDetAttrValue")
        .text()
        .replace(/[\n\r\t\u200e\u200f]/g, "")
        .trim();
      if (key && value && key.length < 60 && value.length < 150) {
        details[key] = value;
      }
    });

    // Add brand to details if not already there
    if (brand && !details["Brand"]) {
      details["Brand"] = brand;
    }

    // Remove fields not useful for comparison
    const excludeKeys = [
      "ASIN",
      "Best Sellers Rank",
      "Date First Available",
      "Number of Items",
      "Customer Reviews",
      "Item model number",
    ];
    excludeKeys.forEach((key) => delete details[key]);

    // --- ATTRIBUTES (color, size, style) ---
    const attributes = {};
    // From variation selectors
    $("#variation_color_name .selection").each((i, el) => {
      attributes.color = $(el).text().trim();
    });
    $("#variation_size_name .selection").each((i, el) => {
      attributes.size = $(el).text().trim();
    });
    $("#variation_style_name .selection").each((i, el) => {
      attributes.style = $(el).text().trim();
    });
    // From product details table
    if (details["Color"]) attributes.color = details["Color"];
    if (details["Size"]) attributes.size = details["Size"];
    if (details["Style"]) attributes.style = details["Style"];
    if (details["Material"]) attributes.material = details["Material"];
    if (details["Capacity"]) attributes.capacity = details["Capacity"];

    res.json({
      title,
      price,
      url: cleanUrl,
      in_stock: !outOfStock,
      is_prime: isPrime,
      currency: "USD",
      brand,
      model,
      gtin, // 👈 เพิ่ม
      attributes, // 👈 เพิ่ม
      rating,
      review_count: reviewCount,
      bought_last_month: boughtLastMonth,
      bullets: bullets.slice(0, 5),
      image,
      details,
    });
  } catch (err) {
    console.error("Scrape error:", err.message);
    res.status(500).json({
      error: "Failed to fetch Amazon page. Please try again.",
    });
  }
});

module.exports = router;
