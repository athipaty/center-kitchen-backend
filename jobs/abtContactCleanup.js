/**
 * abtContactCleanup.js — deletes resolved client feedback requests
 *
 * Requests marked "done" (ดำเนินการแล้ว) are auto-deleted 14 days after their
 * last update, so the list doesn't accumulate stale, already-handled items.
 */

const cron = require('node-cron')
const AbtContactMessage = require('../models/abt/AbtContactMessage')

const RETENTION_DAYS = 14

async function cleanup() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const result = await AbtContactMessage.deleteMany({ status: 'done', updatedAt: { $lt: cutoff } })
  if (result.deletedCount) {
    console.log(`[abtContactCleanup] deleted ${result.deletedCount} request(s) done for ${RETENTION_DAYS}+ days`)
  }
}

function start() {
  cron.schedule('0 19 * * *', cleanup, { timezone: 'UTC' }) // 02:00 TH daily
  console.log('✅ abtContactCleanup scheduled: daily 02:00 TH')
}

module.exports = { start, cleanup }
