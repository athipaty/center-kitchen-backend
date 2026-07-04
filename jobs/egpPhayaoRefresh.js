/**
 * egpPhayaoRefresh.js — nationwide e-GP RSS fetch filtered to พะเยา, all announcement types.
 *
 * Same schedule as egpCacheRefresh.js: 3 fetch passes + 3 enrich passes during the e-GP
 * availability window (17:01–08:59 TH). Fetches nationwide (no dept filter) since there's
 * no province-level RSS parameter — filters by "พะเยา" appearing in the item text instead.
 */

const cron   = require('node-cron')
const axios  = require('axios')
const cheerio = require('cheerio')
const AbtSettings        = require('../models/abt/AbtSettings')
const AbtEgpPhayaoItem   = require('../models/abt/AbtEgpPhayaoItem')
const { enrichAnnouncement } = require('../utils/egpEnrich')

const BASE_URL    = 'https://process3.gprocurement.go.th/EPROCRssFeedWeb/egpannouncerss.xml'
const FETCH_TYPES = ['D0', 'P0', 'W0', 'W2', '15', 'B0']
const PROVINCE_KEYWORD = 'พะเยา'

function isMaintenanceText(str) {
  return /ไม่พร้อมให้บริการ|ปิดปรับปรุง|not available|maintenance/i.test(str || '')
}

function extractProjectId(link) {
  try {
    return new URL(link).searchParams.get('projectId') || null
  } catch {
    return null
  }
}

async function fetchAndCache(anounceType) {
  const { data: buf } = await axios.get(BASE_URL, {
    params: { anounceType }, timeout: 30000, maxRedirects: 5, responseType: 'arraybuffer',
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

  const phayaoItems = rssItems.filter(i => `${i.title} ${i.desc}`.includes(PROVINCE_KEYWORD))
  if (phayaoItems.length === 0) return { ok: true, added: 0 }

  const result = await AbtEgpPhayaoItem.bulkWrite(
    phayaoItems.map(item => ({
      updateOne: {
        filter: { link: item.link },
        update: { $setOnInsert: {
          anounceType,
          projectId: extractProjectId(item.link),
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

  await AbtSettings.findOneAndUpdate(
    { key: 'egp_phayao_meta' },
    { value: { maintenance: false, lastFetchAt: new Date().toISOString() } },
    { upsert: true }
  )

  return { ok: true, added: result.upsertedCount || 0 }
}

async function refreshAll() {
  console.log('[egpPhayaoRefresh] starting nationwide RSS scan for พะเยา...')
  for (const t of FETCH_TYPES) {
    try {
      const r = await fetchAndCache(t)
      console.log(`[egpPhayaoRefresh] type="${t}" →`, r)
    } catch (err) {
      console.error(`[egpPhayaoRefresh] type="${t}" error: ${err.message}`)
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  console.log('[egpPhayaoRefresh] RSS scan done')
}

async function enrichAll() {
  console.log('[egpPhayaoRefresh] enriching pending items...')
  const pending = await AbtEgpPhayaoItem.find({ enriched: false }).limit(50).lean()
  let enriched = 0
  for (const item of pending) {
    const update = await enrichAnnouncement(item.link)
    await AbtEgpPhayaoItem.findByIdAndUpdate(item._id, update)
    if (update.winner || update.agency) enriched++
    await new Promise(r => setTimeout(r, 800))
  }
  console.log(`[egpPhayaoRefresh] enriched ${enriched}/${pending.length} pending items`)
}

function start() {
  cron.schedule('5 11 * * *', refreshAll, { timezone: 'UTC' })  // 18:05 TH
  cron.schedule('5 13 * * *', refreshAll, { timezone: 'UTC' })  // 20:05 TH
  cron.schedule('5 15 * * *', refreshAll, { timezone: 'UTC' })  // 22:05 TH
  cron.schedule('35 11 * * *', enrichAll, { timezone: 'UTC' })  // 18:35 TH
  cron.schedule('35 13 * * *', enrichAll, { timezone: 'UTC' })  // 20:35 TH
  cron.schedule('35 15 * * *', enrichAll, { timezone: 'UTC' })  // 22:35 TH
  console.log('✅ egpPhayaoRefresh scheduled: 18:05/20:05/22:05 TH (RSS) + enrichment 30min after each')
}

module.exports = { start, refreshAll, enrichAll }
