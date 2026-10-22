/**
 * fbGraphSync.js — keeps the homepage "latest Facebook post" in sync via the Graph API
 *
 * Needs FACEBOOK_PAGE_ACCESS_TOKEN (a non-expiring Page Access Token from a page admin).
 * Without it every run is a silent no-op, so the homepage keeps showing whatever the admin
 * entered by hand in ตั้งค่าเว็บไซต์ → "โพสต์ล่าสุดจาก Facebook".
 *
 * Writes the same fbPost* settings the admin form edits. A field is only overwritten when it
 * still holds the value this job wrote last time, so a manual edit sticks until Facebook has
 * something different. This also refreshes full_picture each run — those fbcdn URLs are
 * signed and stop working after a while.
 */

const cron = require('node-cron')
const AbtSettings = require('../models/abt/AbtSettings')

const PAGE = 'MaesaiSAOPhayao'
const FIELDS = ['fbPostText', 'fbPostImage', 'fbPostUrl', 'fbPostDate']
const LAST_KEY = 'fbGraphLastSynced'

async function getSetting(key) {
  return (await AbtSettings.findOne({ key }).lean())?.value
}
async function setSetting(key, value) {
  await AbtSettings.findOneAndUpdate({ key }, { value }, { upsert: true })
}

async function fetchLatestPost(token) {
  // limit=5 then pick the first with content: shares/cover-photo updates can come back empty.
  const url = `https://graph.facebook.com/${PAGE}/posts?fields=message,full_picture,permalink_url,created_time&limit=5&access_token=${encodeURIComponent(token)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  const json = await res.json()
  if (json.error) throw new Error(`${json.error.type || 'GraphError'} ${json.error.code || ''}: ${json.error.message}`)
  const post = (json.data || []).find(p => p.message || p.full_picture)
  if (!post) throw new Error('no post with text or image in the latest 5')
  return {
    fbPostText:  post.message || '',
    fbPostImage: post.full_picture || '',
    fbPostUrl:   post.permalink_url || `https://www.facebook.com/${PAGE}`,
    fbPostDate:  new Date(post.created_time).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'Asia/Bangkok' }),
  }
}

async function runOnce() {
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN
  if (!token) return { success: false, skipped: true, error: 'FACEBOOK_PAGE_ACCESS_TOKEN not set' }
  try {
    const latest = await fetchLatestPost(token)
    const last = (await getSetting(LAST_KEY)) || {}
    const updated = []
    for (const f of FIELDS) {
      const current = await getSetting(f)
      const untouched = current === undefined || current === '' || current === last[f]
      const isNewPost = latest.fbPostUrl !== last.fbPostUrl
      if ((untouched || isNewPost) && current !== latest[f]) {
        await setSetting(f, latest[f])
        updated.push(f)
      }
    }
    await setSetting(LAST_KEY, { ...latest, syncedAt: new Date().toISOString() })
    if (updated.length) console.log(`[fbGraphSync] updated ${updated.join(', ')} — ${latest.fbPostUrl}`)
    return { success: true, updated, post: latest }
  } catch (err) {
    console.error('[fbGraphSync] error:', err.message)
    return { success: false, error: err.message }
  }
}

function start() {
  cron.schedule('*/30 * * * *', runOnce) // every 30 minutes
  setTimeout(runOnce, 30_000)             // and shortly after boot
  console.log('✅ fbGraphSync scheduled: every 30 min (active only when FACEBOOK_PAGE_ACCESS_TOKEN is set)')
}

module.exports = { start, runOnce }
