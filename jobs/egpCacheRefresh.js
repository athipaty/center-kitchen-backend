/**
 * egpCacheRefresh.js
 *
 * Runs every day at 18:00 (Thailand time, UTC+7 = 11:00 UTC) to pre-warm
 * the e-GP RSS cache while the system is available (17:01–08:59).
 *
 * This ensures the MongoDB cache is always fresh so users see real data
 * even when they visit during the maintenance window (09:00–17:00).
 */

const cron    = require('node-cron')
const axios   = require('axios')
const cheerio = require('cheerio')
const AbtSettings = require('../models/abt/AbtSettings')

const DEPT_SUB_ID = '6560105'
const BASE_URL    = 'https://process.gprocurement.go.th/EPROCRssFeedWeb/egpannouncerss.xml'

// Same announce types exposed on the public page
const FETCH_TYPES = ['', 'P0', 'D0', 'W0', '15']

function isMaintenanceText(str) {
  return /ไม่พร้อมให้บริการ|ปิดปรับปรุง|not available|maintenance/i.test(str || '')
}

async function fetchAndCache(anounceType) {
  const params = { deptsubId: DEPT_SUB_ID }
  if (anounceType) params.anounceType = anounceType

  const { data: xml } = await axios.get(BASE_URL, { params, timeout: 20000, maxRedirects: 5 })
  const $ = cheerio.load(xml, { xmlMode: true })

  const channelTitle = $('channel > title').first().text()
  const items = []
  $('item').each((_, el) => {
    items.push({
      title: $(el).find('title').text(),
      link:  $(el).find('link').text(),
      date:  $(el).find('pubDate').text(),
      desc:  $(el).find('description').text(),
    })
  })

  const allText = [channelTitle, ...items.map(i => i.title)].join(' ')
  if (isMaintenanceText(allText) || (items.length > 0 && items.every(i => isMaintenanceText(i.title)))) {
    return { ok: false, reason: 'maintenance' }
  }

  await AbtSettings.findOneAndUpdate(
    { key: `egp_cache_${anounceType}` },
    { value: { items, cachedAt: new Date().toISOString() } },
    { upsert: true }
  )
  return { ok: true, count: items.length }
}

async function refreshAll() {
  console.log('[egpCacheRefresh] starting refresh for all announce types...')
  for (const t of FETCH_TYPES) {
    try {
      const result = await fetchAndCache(t)
      if (result.ok) {
        console.log(`[egpCacheRefresh] type="${t || 'all'}" → cached ${result.count} items`)
      } else {
        console.log(`[egpCacheRefresh] type="${t || 'all'}" → skipped (${result.reason})`)
      }
    } catch (err) {
      console.error(`[egpCacheRefresh] type="${t || 'all'}" → error: ${err.message}`)
    }
    // Small delay between requests to be polite to the government server
    await new Promise(r => setTimeout(r, 2000))
  }
  console.log('[egpCacheRefresh] done')
}

function start() {
  // 18:00 Thailand time = 11:00 UTC  (cron uses server time; Render runs UTC)
  cron.schedule('0 11 * * *', refreshAll, { timezone: 'UTC' })
  console.log('✅ egpCacheRefresh scheduled: daily at 18:00 TH time')
}

module.exports = { start, refreshAll }
