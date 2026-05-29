/**
 * egpCacheRefresh.js — daily RSS fetch + auto-enrichment
 *
 * 18:00 TH (11:00 UTC): fetch all announce types from e-GP RSS.
 * 18:30 TH (11:30 UTC): enrich any items still missing winner/amount
 *   by fetching their announcement detail pages and extracting data.
 */

const cron    = require('node-cron')
const axios   = require('axios')
const cheerio = require('cheerio')
const AbtSettings = require('../models/abt/AbtSettings')

const DEPT_SUB_ID = '1509903843'
const BASE_URL    = 'https://process.gprocurement.go.th/EPROCRssFeedWeb/egpannouncerss.xml'
const FETCH_TYPES = ['D0', 'P0', 'W0', 'W2', '15', 'B0']

function isMaintenanceText(str) {
  return /ไม่พร้อมให้บริการ|ปิดปรับปรุง|not available|maintenance/i.test(str || '')
}

function thaiToNum(str) {
  if (!str) return null
  const thai = '๐๑๒๓๔๕๖๗๘๙'
  const arabic = str.split('').map(c => { const i = thai.indexOf(c); return i >= 0 ? String(i) : c }).join('')
  const n = parseFloat(arabic.replace(/,/g, ''))
  return isNaN(n) ? null : n
}

async function enrichItem(item) {
  if (!item.link || item.winner != null) return item
  try {
    const { data: buf } = await axios.get(item.link, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AbtMaesai/1.0)' },
    })
    const text = new TextDecoder('windows-874').decode(buf)
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

    const titleM  = text.match(/ประกาศผู้ชนะการเสนอราคา\s+(.+?)\s+(?:นั้น|โดย|ตาม)/)
    const winnerM = text.match(/ผู้(?:ได้รับการคัดเลือก|ชนะการเสนอราคา)[^ก-๙]*ได้แก่\s+(.+?)\s+(?:โดยเสนอราคา|ซึ่งมี|งวด|เป็นเงิน)/)
    const amountM = text.match(/เป็นเงินทั้งสิ้น\s+([๐-๙\d,.]+)\s+บาท/)
    const methodM = text.match(/โดย(วิธี[ก-๙a-zA-Z\s\-]+?)(?=\s|$|[,\.])/)

    return {
      ...item,
      title:  titleM  ? titleM[1].trim()  : item.title,
      winner: winnerM ? winnerM[1].trim() : null,
      amount: amountM ? thaiToNum(amountM[1]) : null,
      method: methodM ? methodM[1].trim() : null,
    }
  } catch {
    return item
  }
}

async function fetchAndCache(anounceType) {
  const params = { deptsubId: DEPT_SUB_ID }
  if (anounceType) params.anounceType = anounceType

  const { data: buf } = await axios.get(BASE_URL, {
    params, timeout: 30000, maxRedirects: 5, responseType: 'arraybuffer',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AbtMaesai/1.0)' },
  })
  const xml = new TextDecoder('windows-874').decode(buf)
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
  if (items.length === 0) return { ok: true, added: 0, skipped: 'empty feed' }

  const existing   = await AbtSettings.findOne({ key: `egp_cache_${anounceType}` })
  const oldItems   = existing?.value?.items || []
  const knownLinks = new Set(oldItems.map(i => i.link).filter(Boolean))
  const fresh      = items.filter(i => !knownLinks.has(i.link))
  if (fresh.length === 0) return { ok: true, added: 0, total: oldItems.length }

  const merged = [...fresh, ...oldItems]
  await AbtSettings.findOneAndUpdate(
    { key: `egp_cache_${anounceType}` },
    { value: { items: merged, cachedAt: new Date().toISOString() } },
    { upsert: true }
  )
  return { ok: true, added: fresh.length, total: merged.length }
}

async function enrichAll() {
  console.log('[egpCacheRefresh] enriching all unenriched items...')
  for (const t of FETCH_TYPES) {
    const doc = await AbtSettings.findOne({ key: `egp_cache_${t}` })
    if (!doc?.value?.items?.length) continue

    const items = doc.value.items
    const pending = items.filter(i => !i.winner && i.link)
    if (!pending.length) continue

    console.log(`[egpCacheRefresh] type="${t || 'all'}" enriching ${pending.length} items...`)
    let changed = false
    const updated = []
    for (const item of items) {
      if (!item.winner && item.link) {
        const rich = await enrichItem(item)
        updated.push(rich)
        if (rich.winner !== item.winner) changed = true
        await new Promise(r => setTimeout(r, 800))
      } else {
        updated.push(item)
      }
    }
    if (changed) {
      await AbtSettings.findOneAndUpdate(
        { key: `egp_cache_${t}` },
        { value: { items: updated, cachedAt: doc.value.cachedAt } },
        { upsert: true }
      )
      console.log(`[egpCacheRefresh] type="${t || 'all'}" enriched OK`)
    }
  }
  console.log('[egpCacheRefresh] enrichment done')
}

async function refreshAll() {
  console.log('[egpCacheRefresh] starting RSS refresh...')
  for (const t of FETCH_TYPES) {
    try {
      const r = await fetchAndCache(t)
      console.log(`[egpCacheRefresh] type="${t || 'all'}" →`, r)
    } catch (err) {
      console.error(`[egpCacheRefresh] type="${t || 'all'}" error: ${err.message}`)
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  console.log('[egpCacheRefresh] RSS refresh done')
}

function start() {
  // Run RSS fetch 3× during the available window (17:01–08:59 TH)
  // so announcements published at different times of the day are all captured.
  cron.schedule('0 11 * * *', refreshAll,  { timezone: 'UTC' })  // 18:00 TH
  cron.schedule('0 13 * * *', refreshAll,  { timezone: 'UTC' })  // 20:00 TH
  cron.schedule('0 15 * * *', refreshAll,  { timezone: 'UTC' })  // 22:00 TH
  // Enrich (fetch detail pages for winner/amount) 30 min after each RSS run
  cron.schedule('30 11 * * *', enrichAll, { timezone: 'UTC' })   // 18:30 TH
  cron.schedule('30 13 * * *', enrichAll, { timezone: 'UTC' })   // 20:30 TH
  cron.schedule('30 15 * * *', enrichAll, { timezone: 'UTC' })   // 22:30 TH
  console.log('✅ egpCacheRefresh scheduled: 18:00/20:00/22:00 TH (RSS) + enrichment 30min after each')
}

module.exports = { start, refreshAll, enrichAll }
