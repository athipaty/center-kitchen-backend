/**
 * fbPostScraper.js — best-effort daily scrape of the latest อบต.แม่ใส Facebook post
 *
 * Facebook's Graph API requires page-admin-granted permissions we don't have reliable
 * access to (see /facebook-posts in routes/abt/index.js, which keeps failing on
 * "pages_read_engagement"), and the admin's token setup is a recurring headache. This
 * scrapes mbasic.facebook.com instead — Facebook's lightweight, server-rendered (no JS)
 * page for low-bandwidth devices — which sometimes stays readable to logged-out visitors
 * without needing any token or page-admin access at all.
 *
 * This is explicitly best-effort: scraping breaks Facebook's Terms of Service, mbasic's
 * markup is undocumented and can change without notice, and Facebook may force a login
 * wall for anonymous requests at any time. On any failure this leaves the existing
 * fbPost* settings untouched, so the page falls back to whatever the admin last entered
 * by hand in ตั้งค่าเว็บไซต์ → "โพสต์ล่าสุดจาก Facebook" (or manually overrides any time).
 */

const cron = require('node-cron')
const cheerio = require('cheerio')
const AbtSettings = require('../models/abt/AbtSettings')

const PAGE_URL = 'https://mbasic.facebook.com/MaesaiSAOPhayao'

async function setSetting(key, value) {
  await AbtSettings.findOneAndUpdate({ key }, { value }, { upsert: true })
}

// Routed through ScraperAPI when SCRAPER_API_KEY is set (the same shared key the Amazon/
// grocery trackers use — see scraper.js) so the request comes from a rotating proxy IP
// instead of Render's own, which Facebook's anti-bot checks are more likely to flag as a
// bot. Plain (non-autoparse, non-render) request = 1 credit, same rate as the Amazon
// raw-HTML fallback — at once/day this barely dents the shared monthly credit pool. Falls
// back to fetching mbasic directly when no key is configured (e.g. running locally).
async function fetchPageHtml() {
  const key = process.env.SCRAPER_API_KEY
  if (key) {
    const apiUrl = `https://api.scraperapi.com/?api_key=${key}&url=${encodeURIComponent(PAGE_URL)}`
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`ScraperAPI request failed: HTTP ${res.status}`)
    return res.text()
  }
  const res = await fetch(PAGE_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
      'Accept-Language': 'th,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  })
  return res.text()
}

async function scrapeLatestPost() {
  const html = await fetchPageHtml()
  // No reliable way to read the resolved URL when proxied through ScraperAPI, so the
  // login-wall check is HTML-content-based only (works the same via proxy or direct).
  if (/name="login"/i.test(html) || /<title>\s*Log ?[Ii]n/i.test(html)) {
    throw new Error('Facebook returned a login wall — anonymous scraping is blocked right now')
  }

  const $ = cheerio.load(html)

  // mbasic timeline posts sit inside <div data-ft="..."> containers — this selector and
  // the text/image/link heuristics below are a best-effort guess at mbasic's current
  // markup (undocumented, can change without notice). If this throws, the raw HTML
  // snippet logged by runOnce() below is the starting point for fixing the selectors.
  const firstPost = $('[data-ft]').first()
  if (!firstPost.length) {
    throw new Error('No [data-ft] post container found on the page — markup may have changed')
  }

  const text = firstPost
    .find('div')
    .filter((_, el) => $(el).children().length === 0 && $(el).text().trim().length > 15)
    .first()
    .text()
    .trim()

  const imageSrc = firstPost.find('img').first().attr('src')
  const postLink = firstPost.find('a[href*="story_fbid"], a[href*="/posts/"]').first().attr('href')

  if (!text && !imageSrc) {
    throw new Error('Could not extract post text or image from the first post container')
  }

  return {
    text,
    image: imageSrc ? new URL(imageSrc, PAGE_URL).toString() : '',
    url: postLink ? new URL(postLink, 'https://www.facebook.com').toString() : 'https://www.facebook.com/MaesaiSAOPhayao',
    debugHtml: firstPost.html()?.slice(0, 800) || '',
  }
}

async function runOnce() {
  try {
    const post = await scrapeLatestPost()
    await Promise.all([
      setSetting('fbPostText', post.text),
      setSetting('fbPostImage', post.image),
      setSetting('fbPostUrl', post.url),
      setSetting('fbPostDate', new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'Asia/Bangkok' })),
    ])
    console.log(`[fbPostScraper] success — text: "${post.text.slice(0, 60)}", image: ${post.image ? 'yes' : 'no'}, url: ${post.url}`)
    return { success: true, post: { text: post.text, image: post.image, url: post.url } }
  } catch (err) {
    console.error('[fbPostScraper] error:', err.message)
    return { success: false, error: err.message }
  }
}

function start() {
  cron.schedule('0 23 * * *', runOnce, { timezone: 'UTC' }) // ~06:00 TH daily
  console.log('✅ fbPostScraper scheduled: daily ~06:00 TH')
}

module.exports = { start, runOnce }
