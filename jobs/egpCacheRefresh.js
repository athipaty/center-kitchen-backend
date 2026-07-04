/**
 * egpCacheRefresh.js — daily RSS fetch + auto-enrichment
 *
 * 18:00 TH (11:00 UTC): fetch all announce types from e-GP RSS.
 * 18:30 TH (11:30 UTC): enrich any items still missing winner/amount
 *   by fetching their announcement detail pages and extracting data.
 */

const cron        = require('node-cron')
const axios       = require('axios')
const cheerio     = require('cheerio')
const AbtSettings = require('../models/abt/AbtSettings')
const AbtEgpItem  = require('../models/abt/AbtEgpItem')
const { enrichAnnouncement } = require('../utils/egpEnrich')

const DEPT_SUB_ID = '1509903843'
// CGD manual specifies process3 as the correct hostname for RSS
const BASE_URL    = 'https://process3.gprocurement.go.th/EPROCRssFeedWeb/egpannouncerss.xml'
const FETCH_TYPES = ['D0', 'P0', 'W0', 'W2', '15', 'B0']

function isMaintenanceText(str) {
  return /ไม่พร้อมให้บริการ|ปิดปรับปรุง|not available|maintenance/i.test(str || '')
}

async function enrichItem(item) {
  if (!item.link || item.enriched) return null
  return enrichAnnouncement(item.link)
}

async function fetchAndCache(anounceType) {
  const params = { deptsubId: DEPT_SUB_ID }
  if (anounceType) params.anounceType = anounceType

  const { data: buf } = await axios.get(BASE_URL, {
    params, timeout: 30000, maxRedirects: 5, responseType: 'arraybuffer',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AbtMaesai/1.0)' },
  })
  const xml = new TextDecoder('windows-874').decode(buf)
  const $   = cheerio.load(xml, { xmlMode: true })

  const channelTitle = $('channel > title').first().text()
  const rssItems = []
  $('item').each((_, el) => {
    rssItems.push({
      title: $(el).find('title').text(),
      link:  $(el).find('link').text(),
      date:  $(el).find('pubDate').text(),
      desc:  $(el).find('description').text(),
    })
  })

  const allText = [channelTitle, ...rssItems.map(i => i.title)].join(' ')
  if (isMaintenanceText(allText) || (rssItems.length > 0 && rssItems.every(i => isMaintenanceText(i.title)))) {
    return { ok: false, reason: 'maintenance' }
  }
  if (rssItems.length === 0) return { ok: true, added: 0, skipped: 'empty feed' }

  const result = await AbtEgpItem.bulkWrite(
    rssItems.map(item => ({
      updateOne: {
        filter: { link: item.link },
        update: { $setOnInsert: {
          anounceType,
          title: item.title,
          date:  item.date ? new Date(item.date) : null,
          desc:  item.desc,
          enriched: false,
        }},
        upsert: true,
      }
    })),
    { ordered: false }
  )

  const added = result.upsertedCount || 0

  await AbtSettings.findOneAndUpdate(
    { key: `egp_meta_${anounceType}` },
    { value: { maintenance: false, lastFetchAt: new Date().toISOString() } },
    { upsert: true }
  )

  return { ok: true, added, total: await AbtEgpItem.countDocuments({ anounceType }) }
}

async function enrichAll() {
  console.log('[egpCacheRefresh] enriching all unenriched items...')
  for (const t of FETCH_TYPES) {
    const pending = await AbtEgpItem.find({ anounceType: t, enriched: false }).lean()
    if (!pending.length) continue

    console.log(`[egpCacheRefresh] type="${t}" enriching ${pending.length} items...`)
    let enriched = 0
    for (const item of pending) {
      const update = await enrichItem(item)
      if (update) {
        await AbtEgpItem.findByIdAndUpdate(item._id, update)
        if (update.winner) enriched++
      }
      await new Promise(r => setTimeout(r, 800))
    }
    console.log(`[egpCacheRefresh] type="${t}" enriched ${enriched} winners`)
  }
  console.log('[egpCacheRefresh] enrichment done')
}

async function refreshAll() {
  console.log('[egpCacheRefresh] starting RSS refresh...')
  for (const t of FETCH_TYPES) {
    try {
      const r = await fetchAndCache(t)
      console.log(`[egpCacheRefresh] type="${t}" →`, r)
    } catch (err) {
      console.error(`[egpCacheRefresh] type="${t}" error: ${err.message}`)
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  console.log('[egpCacheRefresh] RSS refresh done')
}

function start() {
  // Run RSS fetch 3× during the available window (17:01–08:59 TH)
  cron.schedule('0 11 * * *', refreshAll, { timezone: 'UTC' })  // 18:00 TH
  cron.schedule('0 13 * * *', refreshAll, { timezone: 'UTC' })  // 20:00 TH
  cron.schedule('0 15 * * *', refreshAll, { timezone: 'UTC' })  // 22:00 TH
  // Enrich 30 min after each RSS run
  cron.schedule('30 11 * * *', enrichAll, { timezone: 'UTC' })  // 18:30 TH
  cron.schedule('30 13 * * *', enrichAll, { timezone: 'UTC' })  // 20:30 TH
  cron.schedule('30 15 * * *', enrichAll, { timezone: 'UTC' })  // 22:30 TH
  console.log('✅ egpCacheRefresh scheduled: 18:00/20:00/22:00 TH (RSS) + enrichment 30min after each')
}

module.exports = { start, refreshAll, enrichAll }
