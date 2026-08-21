const axios = require("axios");
const cheerio = require("cheerio");

// FairPrice's search results are a client-rendered SPA (no data in raw HTML) —
// ScraperAPI's render=true renders it headlessly and returns the resulting DOM,
// same approach already used for Amazon in routes/tracker/index.js. Card markup
// uses hashed styled-components class names (unstable across their deploys) but
// stable data-testid attributes, which is what we key off here.
async function scrapeFairPrice(query) {
  if (!process.env.SCRAPER_API_KEY) throw new Error("SCRAPER_API_KEY not set");

  const { data: html } = await axios.get("http://api.scraperapi.com/", {
    params: {
      api_key: process.env.SCRAPER_API_KEY,
      url: `https://www.fairprice.com.sg/search?query=${encodeURIComponent(query)}`,
      render: true,
      wait_for_selector: '[data-testid="product"]',
    },
    timeout: 90000,
  });

  const $ = cheerio.load(html);
  const results = [];

  $('[data-testid="product"]').each((_, el) => {
    const $el = $(el);
    const metaDivs = $el.find('[data-testid="product-name-and-metadata"] > div');
    const name = metaDivs.eq(0).find("span").last().text().trim();
    const packSize = metaDivs.eq(1).find("span").last().text().trim();
    const text = $el.text();
    const priceMatch = text.match(/\$(\d+\.\d{2})/);
    if (!name || !priceMatch) return; // skip cards we couldn't parse cleanly

    const img = $el.find('[data-testid="recommended-product-image"] img').first();
    const rawSrc = img.attr("src") || img.attr("data-src") || null;
    const imageUrl = rawSrc && !rawSrc.startsWith("data:") ? rawSrc : null; // lazy-load placeholder gif -> no image

    results.push({
      name,
      price: Number(priceMatch[1]),
      packSize: packSize && packSize !== "•" ? packSize : null,
      imageUrl,
    });
  });

  return results;
}

const SCRAPERS = { fairprice: scrapeFairPrice };

// Re-scrape one tracked product's search query and return the best-matching
// listing (first result, since queries are expected to be specific enough that
// the top hit is the tracked item — good enough for MVP; exact matching by name
// could be added later if searches start returning the wrong product first).
async function checkProductPrice(product) {
  const scraper = SCRAPERS[product.supermarket];
  if (!scraper) throw new Error(`No scraper for supermarket "${product.supermarket}"`);

  const results = await scraper(product.searchQuery);
  if (!results.length) throw new Error(`No results for query "${product.searchQuery}"`);

  return results[0];
}

module.exports = { scrapeFairPrice, checkProductPrice, SCRAPERS };
