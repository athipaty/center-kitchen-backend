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
    agency: agencyM ? agencyM[1].trim() : null,
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
      const text = new TextDecoder('windows-874').decode(buf)
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
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

module.exports = { enrichAnnouncement, findProvince, findClosingDate, thaiToNum, PROVINCES }
