// One-off import of the "บัญชีวัสดุไฟฟ้า" Excel workbook into AbtStockItem / AbtStockTransaction.
// Usage: node scripts/seedAbtStock.js "<path-to-xlsx>"
require('dotenv').config()
const mongoose = require('mongoose')
const XLSX = require('xlsx')
const path = require('path')

const AbtStockItem        = require('../models/abt/AbtStockItem')
const AbtStockTransaction = require('../models/abt/AbtStockTransaction')

// Workbook date serials are Buddhist-era shifted (+543 years vs standard Excel epoch)
function fixBuddhistDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return new Date()
  const fixed = new Date(d)
  fixed.setFullYear(fixed.getFullYear() - 543)
  return fixed
}

const filePath = process.argv[2]
if (!filePath) {
  console.error('Usage: node scripts/seedAbtStock.js "<path-to-xlsx>"')
  process.exit(1)
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI)
  console.log('Connected to MongoDB')

  const wb = XLSX.readFile(path.resolve(filePath), { cellDates: true })

  // ── 1. Item master from "รายการ" ────────────────────────────────────────
  const itemRows = XLSX.utils.sheet_to_json(wb.Sheets['รายการ'], { header: 1, defval: '' }).slice(1)
  const itemDocs = itemRows
    .filter(r => r[0] !== '' && r[1] !== '')
    .map(r => ({
      code:      Number(r[0]),
      name:      String(r[1]).trim(),
      unit:      String(r[2] || '').trim(),
      balance:   Number(r[5]) || 0,
      unitPrice: Number(r[6]) || 0,
      category:  'วัสดุไฟฟ้า',
      isActive:  true,
    }))

  await AbtStockTransaction.deleteMany({})
  await AbtStockItem.deleteMany({})
  const inserted = await AbtStockItem.insertMany(itemDocs)
  console.log(`Inserted ${inserted.length} stock items`)

  const codeToId = new Map(inserted.map(it => [it.code, it._id]))

  // ── 2. Transaction history from "เบิก-รับ" ──────────────────────────────
  const txnRows = XLSX.utils.sheet_to_json(wb.Sheets['เบิก-รับ'], { header: 1, defval: '' }).slice(1)
  const txnDocs = []
  let skipped = 0
  for (const r of txnRows) {
    const [dateRaw, type, party, docNo, itemName, qty, unit, unitPrice, , amount, balanceAfter, codeRaw] = r
    const code = Number(codeRaw)
    const itemId = codeToId.get(code)
    if (!itemId || !type || !['รับ', 'จ่าย'].includes(String(type).trim())) { skipped++; continue }
    const qtyNum = Number(qty) || 0
    txnDocs.push({
      item: itemId,
      itemCode: code,
      itemName: String(itemName || '').trim(),
      type: String(type).trim(),
      date: fixBuddhistDate(dateRaw),
      party: String(party || '').trim(),
      docNo: String(docNo || '').trim(),
      qty: qtyNum,
      unit: String(unit || '').trim(),
      unitPrice: Number(unitPrice) || 0,
      amount: Number(amount) || 0,
      balanceAfter: Number(balanceAfter) || 0,
    })
  }
  const insertedTxns = await AbtStockTransaction.insertMany(txnDocs)
  console.log(`Inserted ${insertedTxns.length} transactions (skipped ${skipped} unmatched rows)`)

  await mongoose.disconnect()
  console.log('Done.')
}

main().catch(err => { console.error(err); process.exit(1) })
