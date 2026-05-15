const axios = require("axios");
const cheerio = require("cheerio");

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

const PRICE_SELECTORS = [
  ".priceToPay .a-offscreen",
  ".apexPriceToPay .a-offscreen",
  "#priceblock_ourprice",
  "#priceblock_dealprice",
  "#price_inside_buybox",
  ".a-price .a-offscreen",
];

const TITLE_SELECTORS = ["#productTitle", "#title", "h1.a-size-large"];

function cleanUrl(url) {
  const match = url.match(
    /(https?:\/\/[a-z.]*amazon\.[a-z.]+\/(?:[^/]+\/)?dp\/[A-Z0-9]{10})/i
  );
  return match ? match[1] : url;
}

function parsePrice(text) {
  if (!text) return null;
  const clean = text.replace(/,/g, "").trim();
  const match = clean.match(/[\d]+\.?\d*/);
  return match ? parseFloat(match[0]) : null;
}

function randomAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchProduct(url) {
  let html;
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      headers: {
        "User-Agent": randomAgent(),
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "max-age=0",
      },
    });
    html = res.data;
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }

  const $ = cheerio.load(html);

  if ($("form[action='/errors/validateCaptcha']").length) {
    throw new Error("Amazon is showing a CAPTCHA. Try again in a few minutes.");
  }

  let title = "Unknown product";
  for (const sel of TITLE_SELECTORS) {
    const text = $(sel).first().text().trim();
    if (text) { title = text; break; }
  }

  let price = null;
  for (const sel of PRICE_SELECTORS) {
    const el = $(sel).first();
    const raw = el.attr("content") || el.text();
    price = parsePrice(raw);
    if (price) break;
  }

  if (!price) {
    $(".a-price").each((_, el) => {
      if (price) return false;
      price = parsePrice($(el).find(".a-offscreen").text() || $(el).text());
    });
  }

  if (!price) throw new Error("Price not found. The product may be out of stock or the URL is unsupported.");

  let currency = "$";
  for (const sym of ["฿", "£", "€", "¥", "$"]) {
    if (html.slice(0, 10000).includes(sym)) { currency = sym; break; }
  }

  return { title, price, currency };
}

module.exports = { cleanUrl, fetchProduct };
