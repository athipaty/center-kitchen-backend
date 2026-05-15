const { chromium } = require('playwright');

const PRICE_SELECTORS = [
  '.priceToPay .a-offscreen',
  '.apexPriceToPay .a-offscreen',
  '#priceblock_ourprice',
  '#priceblock_dealprice',
  '#price_inside_buybox',
  '.a-price .a-offscreen',
];

const TITLE_SELECTORS = ['#productTitle', '#title', 'h1.a-size-large'];

function cleanUrl(url) {
  const match = url.match(
    /(https?:\/\/[a-z.]*amazon\.[a-z.]+\/(?:[^/]+\/)?dp\/[A-Z0-9]{10})/i
  );
  return match ? match[1] : url;
}

function parsePrice(text) {
  if (!text) return null;
  const clean = text.replace(/,/g, '').trim();
  const match = clean.match(/[\d]+\.?\d*/);
  return match ? parseFloat(match[0]) : null;
}

async function fetchProduct(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    // Hide webdriver flag so Amazon doesn't detect headless browser
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for price element to actually render (JS-rendered content)
    try {
      await page.waitForSelector(PRICE_SELECTORS.join(', '), { timeout: 8000 });
    } catch {
      // Price selector didn't appear — page might be CAPTCHA or out-of-stock
    }

    let title = 'Unknown product';
    for (const sel of TITLE_SELECTORS) {
      const el = await page.$(sel);
      if (el) {
        const text = (await el.textContent()).trim();
        if (text) { title = text; break; }
      }
    }

    let price = null;
    for (const sel of PRICE_SELECTORS) {
      const el = await page.$(sel);
      if (!el) continue;
      const content = await el.getAttribute('content');
      const text = content || (await el.textContent());
      price = parsePrice(text);
      if (price) break;
    }

    if (!price) {
      const priceEls = await page.$$('.a-price');
      for (const el of priceEls) {
        const offscreen = await el.$('.a-offscreen');
        if (offscreen) {
          price = parsePrice(await offscreen.textContent());
          if (price) break;
        }
      }
    }

    if (!price) {
      const html = await page.content();
      const isRobot = html.includes('robot') || html.includes('captcha') || html.includes('CAPTCHA');
      if (isRobot) throw new Error('Amazon is showing a CAPTCHA. Try again in a few minutes.');
      throw new Error('Price not found. The product may be out of stock or the URL is unsupported.');
    }

    const html = await page.content();
    let currency = '$';
    for (const sym of ['฿', '£', '€', '¥', '$']) {
      if (html.slice(0, 10000).includes(sym)) { currency = sym; break; }
    }

    return { title, price, currency };
  } finally {
    await browser.close();
  }
}

module.exports = { cleanUrl, fetchProduct };
