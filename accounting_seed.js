// accounting_seed.js  —  run once: node accounting_seed.js
// Imports GL entries, raw materials, and FG products from Excel into MongoDB
require('dotenv').config();
const mongoose = require('mongoose');
const XLSX     = require('xlsx');
const path     = require('path');

const GlEntry     = require('./models/accounting/GlEntry');
const GlAccount   = require('./models/accounting/GlAccount');
const RawMaterial = require('./models/accounting/RawMaterial');
const FgProduct   = require('./models/accounting/FgProduct');

const GL_PATH = path.join('C:\\Users\\loret\\OneDrive\\Documents', 'GL Express 1-3.2026.xlsx');
const FG_PATH = path.join('C:\\Users\\loret\\OneDrive\\Documents', "Cost of FG Mar'2026.xlsx");
const COMPANY = 'Express';

/* ── helpers ─────────────────────────────────────────────── */
function parseThaiDate(val) {
  if (!val) return null;
  // XLSX reads dates as Excel serial numbers stored in Buddhist calendar year
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (!d) return null;
    const ceYear = d.y - 543;  // Buddhist → CE
    if (ceYear < 1900 || ceYear > 2100) return null;
    return new Date(ceYear, d.m - 1, d.d);
  }
  // Fallback: text string '2569-01-09'
  const s = String(val).trim().split(' ')[0];
  const p = s.split('-');
  if (p.length !== 3) return null;
  const year  = parseInt(p[0]) - 543;
  const month = parseInt(p[1]) - 1;
  const day   = parseInt(p[2]);
  if (year < 1900 || year > 2100 || isNaN(month) || isNaN(day)) return null;
  return new Date(year, month, day);
}

function n(v) { return parseFloat(v) || 0; }

/* ── Chart of Accounts ───────────────────────────────────── */
const EXPRESS_ACCOUNTS = [
  { code:'1111-00', name:'เงินสด', type:'Asset' },
  { code:'1113-01', name:'เงินฝากออมทรัพย์ K-bank 188-3-50387-9', type:'Asset' },
  { code:'1113-02', name:'เงินฝากออมทรัพย์ K-bank 318-92-0843-9', type:'Asset' },
  { code:'1113-03', name:'เงินฝากออมทรัพย์ ICBC 504-0-15069-4', type:'Asset' },
  { code:'1130-01', name:'ลูกหนี้การค้า', type:'Asset' },
  { code:'1130-05', name:'เงินประกันและเงินมัดจำ', type:'Asset' },
  { code:'1140-01', name:'วัตถุดิบคงเหลือ', type:'Asset' },
  { code:'1140-02', name:'สินค้าสำเร็จรูปคงเหลือ', type:'Asset' },
  { code:'1151-01', name:'ค่าใช้จ่ายจ่ายล่วงหน้า-ค่าสินค้า', type:'Asset' },
  { code:'1151-02', name:'ภาษีนิติบุคคลจ่ายล่วงหน้า', type:'Asset' },
  { code:'1151-04', name:'ค่าใช้จ่ายจ่ายล่วงหน้า-ค่าสอบบัญชี', type:'Asset' },
  { code:'1151-05', name:'ค่าใช้จ่ายจ่ายล่วงหน้า-อื่น ๆ', type:'Asset' },
  { code:'1152-00', name:'เงินทดรองจ่ายพนักงาน', type:'Asset' },
  { code:'1154-00', name:'ภาษีซื้อ', type:'Asset' },
  { code:'1155-00', name:'ภาษีซื้อ-ยังไม่ถึงกำหนด', type:'Asset' },
  { code:'1156-00', name:'ลูกหนี้-กรมสรรพากร', type:'Asset' },
  { code:'1410-03', name:'อุปกรณ์สำนักงาน', type:'Asset' },
  { code:'1410-04', name:'เครื่องตกแต่งสำนักงาน', type:'Asset' },
  { code:'1410-06', name:'สินทรัพย์ไม่มีตัวตน', type:'Asset' },
  { code:'1410-07', name:'เครื่องมือเครื่องใช้', type:'Asset' },
  { code:'1420-03', name:'ค่าเสื่อมราคาสะสม-อุปกรณ์สำนักงาน', type:'Asset' },
  { code:'1420-04', name:'ค่าเสื่อมราคาสะสม-เครื่องตกแต่งสำนักงาน', type:'Asset' },
  { code:'1420-06', name:'ค่าตัดจ่ายซอฟแวร์สะสม', type:'Asset' },
  { code:'1420-07', name:'ค่าเสื่อมราคาสะสม-เครื่องมือเครื่องใช้', type:'Asset' },
  { code:'2120-01', name:'เจ้าหนี้การค้า', type:'Liability' },
  { code:'2131-01', name:'เงินเดือนค้างจ่าย', type:'Liability' },
  { code:'2131-04', name:'เงินประกันสังคมรอนำส่ง', type:'Liability' },
  { code:'2131-09', name:'ค่าใช้จ่ายค้างจ่าย-อื่น ๆ', type:'Liability' },
  { code:'2131-10', name:'ค่าทำบัญชีค้างจ่าย', type:'Liability' },
  { code:'2131-11', name:'ค่าสอบบัญชีค้างจ่าย', type:'Liability' },
  { code:'2132-01', name:'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภงด.1', type:'Liability' },
  { code:'2132-03', name:'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภงด.3', type:'Liability' },
  { code:'2132-04', name:'ภาษีหัก ณ ที่จ่ายค้างจ่าย ภงด.53', type:'Liability' },
  { code:'2133-01', name:'รายได้รับล่วงหน้า-ค่าสินค้า', type:'Liability' },
  { code:'2138-00', name:'เงินกู้ยืมจากกรรมการ', type:'Liability' },
  { code:'3300-00', name:'กำไร(ขาดทุน)', type:'Equity' },
  { code:'4200-04', name:'กำไรจากอัตราแลกเปลี่ยน', type:'Revenue' },
  { code:'4200-08', name:'รายได้อื่น ๆ', type:'Revenue' },
  { code:'5130-04', name:'สติกเกอร์บรรจุภัณฑ์', type:'Expense' },
  { code:'5130-05', name:'ถังเหล็กบรรจุสินค้า', type:'Expense' },
  { code:'5200-01', name:'ค่านายหน้า/Commission', type:'Expense' },
  { code:'5200-02', name:'ค่าโฆษณา', type:'Expense' },
  { code:'5200-05', name:'ค่าขนส่ง', type:'Expense' },
  { code:'5200-06', name:'ค่ารับรอง', type:'Expense' },
  { code:'5200-09', name:'ค่าใช้จ่ายเดินทางและยานพาหนะ', type:'Expense' },
  { code:'5200-11', name:'ค่าใช้จ่ายในการนำเข้า-ส่งออก', type:'Expense' },
  { code:'5310-01', name:'เงินเดือน', type:'Expense' },
  { code:'5310-02', name:'ค่าล่วงเวลา', type:'Expense' },
  { code:'5310-03', name:'ค่าเบี้ยขยัน', type:'Expense' },
  { code:'5310-05', name:'เงินเพิ่มพิเศษ-เดินทาง+อาหาร', type:'Expense' },
  { code:'5310-07', name:'ค่าที่พักอาศัย', type:'Expense' },
  { code:'5310-09', name:'เงินสมทบกองทุนประกันสังคม', type:'Expense' },
  { code:'5310-10', name:'เงินสมทบกองทุนทดแทน', type:'Expense' },
  { code:'5310-17', name:'ค่าสวัสดิการอื่น ๆ', type:'Expense' },
  { code:'5320-01', name:'ค่าเครื่องเขียนแบบพิมพ์', type:'Expense' },
  { code:'5320-03', name:'วัสดุสิ้นเปลือง', type:'Expense' },
  { code:'5320-05', name:'ค่าเช่า', type:'Expense' },
  { code:'5320-08', name:'ค่าบริการ', type:'Expense' },
  { code:'5330-01', name:'ค่าโทรศัพท์', type:'Expense' },
  { code:'5330-02', name:'ค่าไฟฟ้า', type:'Expense' },
  { code:'5330-03', name:'ค่าน้ำประปา', type:'Expense' },
  { code:'5330-04', name:'ค่าไปรษณีย์', type:'Expense' },
  { code:'5330-05', name:'ค่าอินเตอร์เน็ต', type:'Expense' },
  { code:'5340-03', name:'ค่าเสื่อมราคา-อุปกรณ์สำนักงาน', type:'Expense' },
  { code:'5340-04', name:'ค่าเสื่อมราคา-เครื่องตกแต่งสำนักงาน', type:'Expense' },
  { code:'5340-06', name:'ค่าเสื่อมราคา-ซอฟแวร์', type:'Expense' },
  { code:'5340-07', name:'ค่าเสื่อมราคา-เครื่องมือเครื่องใช้', type:'Expense' },
  { code:'5360-03', name:'ภาษีป้าย', type:'Expense' },
  { code:'5360-04', name:'ค่าธรรมเนียมธนาคาร', type:'Expense' },
  { code:'5360-07', name:'ภาษีที่ดินและสิ่งปลูกสร้าง', type:'Expense' },
  { code:'5360-08', name:'ค่าธรรมเนียมอื่นๆ', type:'Expense' },
  { code:'5360-10', name:'ค่าทำบัญชี', type:'Expense' },
  { code:'5370-06', name:'ค่าใช้จ่ายเบ็ดเตล็ด', type:'Expense' },
  { code:'5370-07', name:'กำไรขาดทุนจากอัตราแลกเปลี่ยน', type:'Expense' },
  { code:'5370-09', name:'ค่าจ้างทำของ', type:'Expense' },
  { code:'5370-10', name:'ค่าน้ำมัน', type:'Expense' },
  { code:'5390-02', name:'ภาษีซื้อขอคืนไม่ได้', type:'Expense' },
  { code:'5390-03', name:'เบี้ยปรับเงินเพิ่ม', type:'Expense' },
  { code:'5390-04', name:'ค่าใช้จ่ายต้องห้าม-บิลไม่ครบ', type:'Expense' },
  { code:'9999-99', name:'บัญชีพัก', type:'Other' },
];

async function seedAccounts() {
  await GlAccount.deleteMany({ company: COMPANY });
  await GlAccount.insertMany(EXPRESS_ACCOUNTS.map(a => ({ ...a, company: COMPANY })));
  console.log(`✅ Accounts: ${EXPRESS_ACCOUNTS.length} seeded`);
}

/* ── GL Entries ───────────────────────────────────────────── */
async function importGL() {
  const wb = XLSX.readFile(GL_PATH);
  const ws = wb.Sheets['Sheet1'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  const docs = [];
  for (const row of rows) {
    const code    = row[0] ? String(row[0]).trim() : null;
    const dateVal = row[1];                           // keep as original type (number or string)
    const account = row[2] ? String(row[2]).trim() : '';
    const journal = row[3] ? String(row[3]).trim() : '';
    const voucher = row[4] ? String(row[4]).trim() : '';
    const desc    = row[5] ? String(row[5]).trim() : '';
    const debit   = n(row[7]);
    const credit  = n(row[8]);
    const status  = row[9] ? String(row[9]).trim() : '';

    // Skip header rows and balance summary rows
    if (!code || dateVal === null || dateVal === undefined) continue;
    if (dateVal === 'วันที่') continue;              // column header
    if (String(dateVal) === code) continue;         // balance header (date text = code)
    if (typeof dateVal === 'string' && !dateVal.includes('-')) continue; // non-date string

    const date = parseThaiDate(dateVal);
    if (!date) continue;

    // Skip rows with no debit or credit
    if (debit === 0 && credit === 0) continue;

    docs.push({ code, date, account, journal, voucher, description: desc, debit, credit, status, company: COMPANY });
  }

  await GlEntry.deleteMany({ company: COMPANY });
  await GlEntry.insertMany(docs, { ordered: false });
  console.log(`✅ GL Entries: ${docs.length} imported`);
}

/* ── Raw Materials ───────────────────────────────────────── */
async function importMaterials() {
  const wb = XLSX.readFile(FG_PATH);
  const ws = wb.Sheets['วัตถุดิบคงเหลือ'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  const docs = [];
  for (const row of rows) {
    const code = row[1] ? String(row[1]).trim() : null;
    if (!code || !code.startsWith('RM-')) continue;

    const name = String(row[2] || '').trim();
    const unit = String(row[6] || 'KGM').trim();

    // January 2026
    const janOpen = n(row[9]);
    const janRecv = n(row[10]);
    const janIssued = n(row[11]);
    const janBal  = n(row[12]) || n(row[19]);
    const janCost = n(row[15]);
    const janVal  = n(row[16]);
    docs.push({ code, name, unit, openingBalance: janOpen, received: janRecv, issued: janIssued,
      balance: janBal, latestCost: janCost, avgCost: janCost, totalValue: janVal,
      month: 1, year: 2026, company: COMPANY });

    // February 2026
    const febOpen = janBal;
    const febRecv = n(row[22]);
    const febBal  = n(row[20]);
    const febIssued = Math.max(0, febOpen + febRecv - febBal);
    const febCost = n(row[25]) || janCost;
    const febVal  = n(row[26]);
    docs.push({ code, name, unit, openingBalance: febOpen, received: febRecv, issued: febIssued,
      balance: febBal, latestCost: febCost, avgCost: febCost, totalValue: febVal,
      month: 2, year: 2026, company: COMPANY });

    // March 2026
    const marOpen = febBal;
    const marRecv = n(row[29]);
    const marBal  = n(row[27]);
    const marIssued = Math.max(0, marOpen + marRecv - marBal);
    const marCost = n(row[32]) || febCost;
    const marVal  = n(row[33]);
    docs.push({ code, name, unit, openingBalance: marOpen, received: marRecv, issued: marIssued,
      balance: marBal, latestCost: marCost, avgCost: marCost, totalValue: marVal,
      month: 3, year: 2026, company: COMPANY });
  }

  await RawMaterial.deleteMany({ company: COMPANY });
  await RawMaterial.insertMany(docs, { ordered: false });
  console.log(`✅ Raw Materials: ${docs.length} records (${docs.length / 3} materials × 3 months)`);
}

/* ── FG Products ─────────────────────────────────────────── */
async function importFGProducts() {
  const wb = XLSX.readFile(FG_PATH);
  const ws = wb.Sheets['ต้นทุนผลิตสินค้า 3.26'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  const docs = [];
  for (const row of rows) {
    if (row[1] !== 'RM') continue;
    const code = row[2] ? String(row[2]).trim() : null;
    if (!code || !code.startsWith('FG-')) continue;

    const name          = String(row[3] || '').replace(/\s+/g, ' ').trim();
    const openingBalance = n(row[4]);
    const received      = n(row[5]);
    const issued        = Math.abs(n(row[6]));  // stored as 0 or negative in Excel
    const balance       = n(row[7]);
    const rmCost        = Math.abs(n(row[8]));  // DM column in Excel = RM cost
    const ohCost        = Math.abs(n(row[9]));
    const pkCost        = Math.abs(n(row[10]));
    const totalCost     = rmCost + ohCost + pkCost;
    const qtyProduced   = issued || received || 1;
    const unitCost      = totalCost > 0 ? totalCost / qtyProduced : 0;

    docs.push({ code, name, openingBalance, received, issued, balance,
      rmCost, dmCost: 0, ohCost, pkCost, totalCost, unitCost,
      month: 3, year: 2026, company: COMPANY });
  }

  await FgProduct.deleteMany({ company: COMPANY });
  await FgProduct.insertMany(docs, { ordered: false });
  console.log(`✅ FG Products: ${docs.length} products imported (March 2026)`);
}

/* ── Run ─────────────────────────────────────────────────── */
async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB\n');

  await seedAccounts();
  await importGL();
  await importMaterials();
  await importFGProducts();

  console.log('\n🎉 All data imported successfully!');
  await mongoose.disconnect();
}

main().catch(err => { console.error('❌', err); process.exit(1); });
