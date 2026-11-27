const axios = require('axios')

// Thailand's 77 provinces, used to spot which province an announcement belongs to.
// Best-effort substring match against agency/body text — order doesn't matter since
// no province's full name is a substring of another's.
const PROVINCES = [
  'กรุงเทพมหานคร', 'กระบี่', 'กาญจนบุรี', 'กาฬสินธุ์', 'กำแพงเพชร', 'ขอนแก่น', 'จันทบุรี',
  'ฉะเชิงเทรา', 'ชลบุรี', 'ชัยนาท', 'ชัยภูมิ', 'ชุมพร', 'เชียงราย', 'เชียงใหม่', 'ตรัง', 'ตราด',
  'ตาก', 'นครนายก', 'นครปฐม', 'นครพนม', 'นครราชสีมา', 'นครศรีธรรมราช', 'นครสวรรค์', 'นนทบุรี',
  'นราธิวาส', 'น่าน', 'บึงกาฬ', 'บุรีรัมย์', 'ปทุมธานี', 'ประจวบคีรีขันธ์', 'ปราจีนบุรี', 'ปัตตานี',
  'พระนครศรีอยุธยา', 'พะเยา', 'พังงา', 'พัทลุง', 'พิจิตร', 'พิษณุโลก', 'เพชรบุรี', 'เพชรบูรณ์', 'แพร่',
  'ภูเก็ต', 'มหาสารคาม', 'มุกดาหาร', 'แม่ฮ่องสอน', 'ยโสธร', 'ยะลา', 'ร้อยเอ็ด', 'ระนอง', 'ระยอง',
  'ราชบุรี', 'ลพบุรี', 'ลำปาง', 'ลำพูน', 'เลย', 'ศรีสะเกษ', 'สกลนคร', 'สงขลา', 'สตูล', 'สมุทรปราการ',
  'สมุทรสงคราม', 'สมุทรสาคร', 'สระแก้ว', 'สระบุรี', 'สิงห์บุรี', 'สุโขทัย', 'สุพรรณบุรี', 'สุราษฎร์ธานี',
  'สุรินทร์', 'หนองคาย', 'หนองบัวลำภู', 'อ่างทอง', 'อำนาจเจริญ', 'อุดรธานี', 'อุตรดิตถ์', 'อุทัยธานี',
  'อุบลราชธานี',
]

const THAI_MONTHS = {
  'มกราคม': 1, 'กุมภาพันธ์': 2, 'มีนาคม': 3, 'เมษายน': 4, 'พฤษภาคม': 5, 'มิถุนายน': 6,
  'กรกฎาคม': 7, 'สิงหาคม': 8, 'กันยายน': 9, 'ตุลาคม': 10, 'พฤศจิกายน': 11, 'ธันวาคม': 12,
}

function thaiToNum(str) {
  if (!str) return null
  const thai = '๐๑๒๓๔๕๖๗๘๙'
  const arabic = str.split('').map(c => { const i = thai.indexOf(c); return i >= 0 ? String(i) : c }).join('')
  const n = parseFloat(arabic.replace(/,/g, ''))
  return isNaN(n) ? null : n
}

function findProvince(text) {
  if (!text) return null
  return PROVINCES.find(p => text.includes(p)) || null
}

// Best-effort — bidding announcement wording varies by agency/template, so this
// only catches the common "ยื่นข้อเสนอ...ในวันที่ <day> <month> <พ.ศ. year>" phrasing.
function findClosingDate(text) {
  if (!text) return null
  const m = text.match(/ยื่นข้อเสนอ[\s\S]{0,80}?(?:ใน)?วันที่\s*([๐-๙\d]{1,2})\s*([ก-๙]+)\s*([๐-๙\d]{4})/)
  if (!m) return null
  const day = thaiToNum(m[1])
  const month = THAI_MONTHS[m[2]]
  const beYear = thaiToNum(m[3])
  if (!day || !month || !beYear) return null
  const ceYear = beYear - 543
  const date = new Date(Date.UTC(ceYear, month - 1, day))
  return isNaN(date.getTime()) ? null : date
}

function isPdfBuffer(buf) {
  return buf.length >= 4 && buf.slice(0, 4).toString('latin1') === '%PDF'
}

// The page as plain text: scripts and styles dropped (their code used to leak into the agency name), tags removed
function htmlToText(buf) {
  return new TextDecoder('windows-874').decode(buf)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
}

function extractFromHtmlText(text) {
  const titleM  = text.match(/ประกาศผู้ชนะการเสนอราคา\s+(.+?)\s+(?:นั้น|โดย|ตาม)/)
  const winnerM = text.match(/ผู้(?:ได้รับการคัดเลือก|ชนะการเสนอราคา)[^ก-๙]*ได้แก่\s+(.+?)\s+(?:โดยเสนอราคา|ซึ่งมี|งวด|เป็นเงิน)/)
  const amountM = text.match(/เป็นเงินทั้งสิ้น\s+([๐-๙\d,.]+)\s+บาท/)
  const methodM = text.match(/โดย(วิธี[ก-๙a-zA-Z\s\-]+?)(?=\s|$|[,\.])/)
  const agencyM = text.slice(0, 800).match(/ประกาศ([^\n]+?)(?:\s{2,}|เรื่อง)/)

  return {
    title:  titleM  ? titleM[1].trim()  : undefined,
    winner: winnerM ? winnerM[1].trim() : null,
    amount: amountM ? thaiToNum(amountM[1]) : null,
    method: methodM ? methodM[1].trim() : null,
    agency: agencyM ? agencyM[1].split('ประกาศ').pop().replace(/^[\s()]+|[\s()]+$/g, '').trim() || null : null,
    province: findProvince(text),
    closingDate: findClosingDate(text),
  }
}

function extractFromPdfText(text) {
  const agencyM = text.slice(0, 800).match(/ประกาศ([^\n]+?)\n+เรื่อง/)
  const budgetM = text.match(/เป็นเงินทั้งสิ้น[\s\S]{0,80}?([๐-๙\d][๐-๙\d,]*\.[๐-๙\d]{2})\s*บาท/)

  return {
    agency: agencyM ? agencyM[1].trim() : null,
    budget: budgetM ? thaiToNum(budgetM[1]) : null,
    province: findProvince(text),
    closingDate: findClosingDate(text),
  }
}

function hasUsefulData(fields) {
  return Boolean(fields.title || fields.winner || fields.amount || fields.agency || fields.budget)
}

// Fetches an e-GP announcement link and extracts whatever structured fields it can.
// Links point to either an HTML template page or a raw PDF depending on the agency/type,
// so try the HTML path first and fall back to PDF parsing if that comes up empty.
async function enrichAnnouncement(link) {
  if (!link) return { enriched: true }
  try {
    const { data: buf } = await axios.get(link, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AbtMaesai/1.0)' },
    })

    if (!isPdfBuffer(buf)) {
      const text = htmlToText(buf)
      const fields = extractFromHtmlText(text)
      if (hasUsefulData(fields)) return { ...fields, enriched: true }
    }

    const { PDFParse } = require('pdf-parse')
    const parser = new PDFParse({ data: buf })
    const { text: pdfText } = await parser.getText()
    return { ...extractFromPdfText(pdfText), enriched: true }
  } catch {
    return { enriched: true }
  }
}

// Reads one fetched announcement (an e-GP HTML page or a PDF) into its fields, with no AI: the winner, amount,
// method and title phrases are the standard e-GP template wording, and PDFs are read for their text first
// (pdf-parse). Used by ABT's Summarize button.
async function extractAnnouncement(buf) {
  if (!isPdfBuffer(buf)) return extractFromHtmlText(htmlToText(buf))
  const { PDFParse } = require('pdf-parse')
  const parser = new PDFParse({ data: buf })
  try {
    const { text: raw } = await parser.getText()
    // Thai PDFs often store "ำ" as nikhahit + sara aa, and lose a tone mark that sits over an upper vowel
    // (it comes out as \u0000): "ทั้งสิ้น" reads "ทั\u0000งสิ\u0000น". So amounts are found in a copy without tone
    // marks (the digits are never affected), and names are kept only when nothing in them was lost.
    const text = raw.replace(/ํา/g, 'ำ')
    const flat = text.replace(/\s+/g, ' ')
    const loose = flat.replace(/[\u0000่-๋]/g, '')
    const html = extractFromHtmlText(flat), pdf = extractFromPdfText(text)
    const clean = (v) => (typeof v === 'string' && !v.includes('\u0000') ? v : null)
    const moneyM = loose.match(/เป็นเงินทังสิน\s*([๐-๙\d][๐-๙\d,]*(?:\.[๐-๙\d]{2})?)\s*บาท/)
    const money = moneyM ? thaiToNum(moneyM[1]) : null
    const winner = clean(html.winner)
    // in a winner announcement that sum is the winning price; in an invitation it is the budget
    const hasWinner = /ผู(?:ได|้ได)?[\u0000่-๋]?รับการคัดเลือก|ผู[\u0000่-๋]?ชนะการเสนอราคา/.test(flat)
    return {
      title: clean(html.title) || undefined, winner, method: clean(html.method),
      amount: html.amount != null ? html.amount : hasWinner ? money : null,
      budget: pdf.budget != null ? pdf.budget : hasWinner ? null : money,
      agency: clean(pdf.agency) || clean(html.agency), province: pdf.province || html.province, closingDate: pdf.closingDate || html.closingDate,
    }
  } finally { if (parser.destroy) await parser.destroy() }
}

module.exports = { enrichAnnouncement, extractAnnouncement, htmlToText, findProvince, findClosingDate, thaiToNum, PROVINCES }
