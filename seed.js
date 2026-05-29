/**
 * seed.js — populate อบต.แม่ใส database with sample data
 *
 * Usage:
 *   node seed.js          — insert sample data (skips if collection already has docs)
 *   node seed.js --fresh  — wipe all ABT collections first, then insert
 */

require('dotenv').config()
const mongoose = require('mongoose')

const AbtNews          = require('./models/abt/AbtNews')
const AbtAnnouncement  = require('./models/abt/AbtAnnouncement')
const AbtProcurement   = require('./models/abt/AbtProcurement')
const AbtProcurementPlan = require('./models/abt/AbtProcurementPlan')
const AbtStaff         = require('./models/abt/AbtStaff')
const AbtTravel        = require('./models/abt/AbtTravel')
const AbtProduct       = require('./models/abt/AbtProduct')
const AbtDocument      = require('./models/abt/AbtDocument')
const AbtSettings      = require('./models/abt/AbtSettings')

const FRESH = process.argv.includes('--fresh')

// ── Helpers ────────────────────────────────────────────────────────────────────
function daysAgo(n) { return new Date(Date.now() - n * 86_400_000) }

async function seed(Model, docs, label) {
  const existing = await Model.countDocuments()
  if (existing > 0 && !FRESH) {
    console.log(`  ⏭  ${label}: already has ${existing} docs — skipping (use --fresh to overwrite)`)
    return
  }
  await Model.deleteMany({})
  await Model.insertMany(docs)
  console.log(`  ✅ ${label}: inserted ${docs.length} docs`)
}

// ── Seed data ─────────────────────────────────────────────────────────────────

const news = [
  {
    title: 'อบต.แม่ใส จัดโครงการวันเด็กแห่งชาติ ประจำปี 2568',
    content: '<p>องค์การบริหารส่วนตำบลแม่ใส ได้จัดโครงการวันเด็กแห่งชาติ ประจำปี 2568 ในวันที่ 11 มกราคม 2568 ณ ลานกิจกรรม อบต.แม่ใส โดยมีกิจกรรมมากมายสำหรับน้องๆ เยาวชน ได้แก่ การแสดงบนเวที เกมสนุก ของขวัญ และอาหารมากมาย</p><p>กิจกรรมนี้จัดขึ้นเพื่อส่งเสริมพัฒนาการและความสุขให้กับเด็กและเยาวชนในชุมชน</p>',
    department: 'childdev',
    views: 142,
    publishedAt: daysAgo(8),
    isActive: true,
  },
  {
    title: 'ประกาศผลการเลือกตั้งสมาชิกสภา อบต.แม่ใส',
    content: '<p>ตามที่ได้มีการเลือกตั้งสมาชิกสภาองค์การบริหารส่วนตำบลแม่ใส เมื่อวันที่ 28 พฤศจิกายน 2567 นั้น คณะกรรมการการเลือกตั้งประจำจังหวัดพะเยาได้ประกาศผลการเลือกตั้งอย่างเป็นทางการแล้ว</p>',
    department: 'council',
    views: 389,
    publishedAt: daysAgo(15),
    isActive: true,
  },
  {
    title: 'โครงการซ่อมแซมถนนสายหลักหมู่ที่ 3 แล้วเสร็จ',
    content: '<p>งานโยธาและสิ่งแวดล้อม อบต.แม่ใส ได้ดำเนินการซ่อมแซมถนนคอนกรีตสายหลักหมู่ที่ 3 บ้านแม่ใสเหนือ ระยะทาง 480 เมตร แล้วเสร็จเรียบร้อย ประชาชนสามารถสัญจรได้ตามปกติ</p>',
    department: 'engineering',
    views: 276,
    publishedAt: daysAgo(20),
    isActive: true,
  },
  {
    title: 'การประชุมสภา อบต.แม่ใส สมัยสามัญที่ 1/2568',
    content: '<p>สภาองค์การบริหารส่วนตำบลแม่ใส ได้ประชุมสมัยสามัญที่ 1 ประจำปี 2568 เมื่อวันที่ 20 กุมภาพันธ์ 2568 โดยมีระเบียบวาระสำคัญ ได้แก่ การพิจารณาแผนพัฒนาท้องถิ่น และการพิจารณาอนุมัติงบประมาณโครงการต่างๆ</p>',
    department: 'council',
    views: 98,
    publishedAt: daysAgo(30),
    isActive: true,
  },
  {
    title: 'รับสมัครอาสาสมัครสาธารณสุขประจำหมู่บ้าน (อสม.) รุ่นใหม่',
    content: '<p>กองสาธารณสุขและสิ่งแวดล้อม อบต.แม่ใส เปิดรับสมัครอาสาสมัครสาธารณสุขประจำหมู่บ้าน (อสม.) รุ่นใหม่ ผู้สนใจต้องมีคุณสมบัติดังนี้ อายุ 18–60 ปี มีภูมิลำเนาในเขต อบต.แม่ใส มีจิตอาสาและความเสียสละ</p>',
    department: 'health',
    views: 211,
    publishedAt: daysAgo(5),
    isActive: true,
  },
  {
    title: 'ประกาศงบประมาณรายจ่ายประจำปี 2568',
    content: '<p>อบต.แม่ใส ขอแจ้งประกาศใช้ข้อบัญญัติงบประมาณรายจ่ายประจำปีงบประมาณ พ.ศ. 2568 วงเงินรวมทั้งสิ้น 19,800,000 บาท แบ่งเป็นงบรายจ่ายด้านการบริหาร งานพัฒนาโครงสร้างพื้นฐาน และงานส่งเสริมคุณภาพชีวิต</p>',
    department: 'finance',
    views: 334,
    publishedAt: daysAgo(45),
    isActive: true,
  },
  {
    title: 'โครงการอบรมป้องกันและบรรเทาสาธารณภัย ประจำปี 2568',
    content: '<p>งานป้องกันและบรรเทาสาธารณภัย อบต.แม่ใส ได้จัดฝึกอบรมชุดอาสาสมัครป้องกันและบรรเทาสาธารณภัย (อปพร.) ประจำปี 2568 ณ ศาลาประชาคม ตำบลแม่ใส เพื่อเสริมทักษะการระงับอัคคีภัยและการช่วยเหลือผู้ประสบภัย</p>',
    department: 'disaster',
    views: 87,
    publishedAt: daysAgo(12),
    isActive: true,
  },
  {
    title: 'อบต.แม่ใส มอบถุงยังชีพช่วยเหลือผู้ประสบอุทกภัย',
    content: '<p>นายกองค์การบริหารส่วนตำบลแม่ใส พร้อมคณะผู้บริหาร ลงพื้นที่มอบถุงยังชีพให้แก่ราษฎรผู้ประสบอุทกภัยในพื้นที่ตำบลแม่ใส จำนวน 120 ครัวเรือน พร้อมสำรวจความเสียหายเพื่อช่วยเหลือต่อไป</p>',
    department: 'office',
    views: 456,
    publishedAt: daysAgo(3),
    isActive: true,
  },
]

const announcements = [
  {
    title: 'ประกาศรับสมัครพนักงานจ้าง ตำแหน่งผู้ช่วยนักวิเคราะห์นโยบายและแผน',
    type: 'announcement',
    isActive: true,
    publishedAt: daysAgo(2),
  },
  {
    title: 'แจ้งกำหนดการชำระภาษีที่ดินและสิ่งปลูกสร้าง ประจำปี 2568',
    type: 'announcement',
    isActive: true,
    publishedAt: daysAgo(10),
  },
  {
    title: 'ประกาศใช้แผนพัฒนาท้องถิ่น (พ.ศ. 2566–2570) เพิ่มเติม ฉบับที่ 2',
    type: 'announcement',
    isActive: true,
    publishedAt: daysAgo(25),
  },
  {
    title: 'จดหมายข่าว อบต.แม่ใส ฉบับที่ 1/2568 (มกราคม–มีนาคม)',
    type: 'newsletter',
    isActive: true,
    publishedAt: daysAgo(40),
  },
  {
    title: 'ประกาศผลผู้ชนะการเสนอราคาจ้างซ่อมแซมถนน หมู่ที่ 5',
    type: 'announcement',
    isActive: true,
    publishedAt: daysAgo(18),
  },
]

const procurement = [
  {
    title: 'ประกาศซื้อครุภัณฑ์คอมพิวเตอร์ โน้ตบุ๊ก จำนวน 3 เครื่อง',
    type: 'news',
    externalUrl: '',
    isActive: true,
    publishedAt: daysAgo(5),
  },
  {
    title: 'จัดจ้างโครงการก่อสร้างรางระบายน้ำ ค.ส.ล. หมู่ที่ 2 ยาว 200 ม.',
    type: 'egp',
    externalUrl: 'https://process.gprocurement.go.th/',
    isActive: true,
    publishedAt: daysAgo(8),
  },
  {
    title: 'จัดจ้างซ่อมแซมอาคารสำนักงาน อบต.แม่ใส',
    type: 'news',
    externalUrl: '',
    isActive: true,
    publishedAt: daysAgo(14),
  },
  {
    title: 'ประกาศซื้อวัสดุงานบ้านงานครัว ประจำปีงบประมาณ 2568',
    type: 'news',
    externalUrl: '',
    isActive: true,
    publishedAt: daysAgo(20),
  },
  {
    title: 'จัดจ้างก่อสร้างถนน ค.ส.ล. สายทางเชื่อมหมู่ที่ 6-7',
    type: 'egp',
    externalUrl: 'https://process.gprocurement.go.th/',
    isActive: true,
    publishedAt: daysAgo(30),
  },
]

const staff = [
  // ฝ่ายบริหาร
  { name: 'นาย สันติ สารเร็ว',      position: 'นายกองค์การบริหารส่วนตำบลแม่ใส', department: 'executive', level: 1, order: 1, phone: '089-757-7366', isActive: true },
  { name: 'นาง วรรณี ปัญญาคม',      position: 'รองนายก อบต. คนที่ 1',             department: 'executive', level: 2, order: 1, isActive: true },
  { name: 'นาย ชัยวัฒน์ มาลัยทอง',  position: 'รองนายก อบต. คนที่ 2',             department: 'executive', level: 2, order: 2, isActive: true },
  { name: 'นาย ประเสริฐ ดีงาม',      position: 'เลขานุการนายก อบต.',              department: 'executive', level: 2, order: 3, isActive: true },
  // สำนักปลัด
  { name: 'นาง สุดาพร กาญจนสุวรรณ', position: 'ปลัดองค์การบริหารส่วนตำบล',       department: 'office',    level: 1, order: 1, phone: '054-489-909', isActive: true },
  { name: 'นาย อรรถพล ยาวงศ์',       position: 'รองปลัด อบต.',                    department: 'office',    level: 2, order: 1, isActive: true },
  { name: 'นางสาว กัลยา บุญมา',      position: 'นักวิเคราะห์นโยบายและแผน',        department: 'office',    level: 3, order: 1, isActive: true },
  { name: 'นาย ธีรวัฒน์ คำสุข',      position: 'นักทรัพยากรบุคคล',               department: 'office',    level: 3, order: 2, isActive: true },
  // กองคลัง
  { name: 'นาง มณีรัตน์ สิงห์ทอง',   position: 'ผู้อำนวยการกองคลัง',              department: 'finance',   level: 1, order: 1, isActive: true },
  { name: 'นางสาว จิราพร ทองดี',     position: 'นักวิชาการเงินและบัญชี',           department: 'finance',   level: 2, order: 1, isActive: true },
  // กองช่าง
  { name: 'นาย วิชัย สุขเกษม',       position: 'ผู้อำนวยการกองช่าง',              department: 'engineering', level: 1, order: 1, isActive: true },
  { name: 'นาย สมชาย พรมทอง',        position: 'นายช่างโยธา',                     department: 'engineering', level: 2, order: 1, isActive: true },
]

const travel = [
  {
    title: 'วัดศรีโคมคำ (วัดพระเจ้าตนหลวง)',
    description: 'วัดเก่าแก่อายุกว่า 500 ปี ประดิษฐาน "พระเจ้าตนหลวง" พระพุทธรูปขนาดใหญ่ที่สุดในเมืองพะเยา สูง 18 เมตร งดงามด้วยศิลปะล้านนาแท้ เป็นสถานที่ศักดิ์สิทธิ์คู่บ้านคู่เมืองพะเยา นักท่องเที่ยวควรสวมใส่เสื้อผ้าสุภาพเมื่อเข้าชม',
    views: 512,
    isActive: true,
  },
  {
    title: 'กว๊านพะเยา',
    description: 'ทะเลสาบน้ำจืดที่ใหญ่ที่สุดในภาคเหนือ พื้นที่ประมาณ 12,831 ไร่ เป็นแหล่งประมงและแหล่งท่องเที่ยวธรรมชาติที่สำคัญ สามารถนั่งเรือชมทิวทัศน์ พระอาทิตย์ตกสวยงาม และชิมอาหารทะเลสาบสด',
    views: 784,
    isActive: true,
  },
  {
    title: 'น้ำตกจำปาทอง',
    description: 'น้ำตกธรรมชาติในป่าชุมชนตำบลแม่ใส มี 3 ชั้น น้ำใสสะอาด บรรยากาศร่มรื่น เหมาะสำหรับพักผ่อน ปิกนิก และถ่ายภาพ เส้นทางเดินป่าระยะ 1.2 กม. จากลานจอดรถ',
    views: 235,
    isActive: true,
  },
  {
    title: 'ศูนย์หัตถกรรมผ้าทอมือบ้านแม่ใส',
    description: 'แหล่งเรียนรู้และจำหน่ายผ้าทอมือพื้นเมืองของชุมชนตำบลแม่ใส ผ้าทอลายโบราณของชาวไทยพวน นักท่องเที่ยวสามารถชมการทอผ้าสาธิต และเลือกซื้อผ้าผืน เสื้อผ้าสำเร็จรูป และของที่ระลึก',
    views: 163,
    isActive: true,
  },
]

const products = [
  {
    title: 'ผ้าทอมือลายน้ำไหลบ้านแม่ใส',
    description: 'ผ้าทอมือพื้นเมืองลายน้ำไหล ทอด้วยไหมพรม 100% สีธรรมชาติ ฝีมือชาวบ้านตำบลแม่ใส ความกว้าง 90 ซม. ยาว 200 ซม. เหมาะทำเป็นผ้าคลุมหรือตัดเย็บเสื้อผ้า',
    price: 850,
    views: 94,
    isActive: true,
  },
  {
    title: 'น้ำพริกหนุ่มสูตรโบราณ',
    description: 'น้ำพริกหนุ่มสูตรดั้งเดิมของตำบลแม่ใส ทำจากพริกหนุ่มย่างไฟ กระเทียม หอมแดง ปราศจากสารกันบูด บรรจุขวดแก้ว 200 กรัม รสชาติกลมกล่อม รับประทานกับผักสด หรือข้าวเหนียวนึ่ง',
    price: 120,
    views: 176,
    isActive: true,
  },
  {
    title: 'ข้าวสังข์หยดอินทรีย์ตำบลแม่ใส',
    description: 'ข้าวสังข์หยดพันธุ์พื้นเมือง ปลูกแบบอินทรีย์ ไม่ใช้สารเคมี มีสรรพคุณบำรุงร่างกาย สีสวยงาม รสชาติหอมนุ่ม บรรจุถุงขนาด 1 กก.',
    price: 95,
    views: 203,
    isActive: true,
  },
  {
    title: 'ตะกร้าไม้ไผ่สานลายดอกมะลิ',
    description: 'ตะกร้าไม้ไผ่สานลายดอกมะลิ ทำมือโดยกลุ่มสตรีตำบลแม่ใส ขนาด 30×20×15 ซม. แข็งแรง ทนทาน ใช้ได้จริง ทำเป็นของขวัญหรือของฝากได้สวยงาม',
    price: 180,
    views: 89,
    isActive: true,
  },
  {
    title: 'สบู่สมุนไพรขมิ้นผสมน้ำผึ้ง',
    description: 'สบู่สมุนไพรสูตรพิเศษ ผสมขมิ้นชันและน้ำผึ้งแท้จากชุมชน ช่วยบำรุงผิวพรรณ ลดรอยด่างดำ สูตร cold process ไม่ใส่สารเคมีฟอกขาว บรรจุ 100 กรัม',
    price: 65,
    views: 147,
    isActive: true,
  },
  {
    title: 'กาแฟดอยแม่ใสคั่วกลาง (200 กรัม)',
    description: 'เมล็ดกาแฟอราบิก้าปลูกบนดอยในเขตตำบลแม่ใส ระดับความสูง 800–1,200 เมตร คั่วระดับกลาง (Medium Roast) กลิ่นหอม รสสมดุล ความเป็นกรดต่ำ เหมาะทำเป็นกาแฟดริปหรือเอสเปรสโซ',
    price: 220,
    views: 261,
    isActive: true,
  },
]

const settings = [
  { key: 'org_name',    value: 'องค์การบริหารส่วนตำบลแม่ใส' },
  { key: 'org_name_en', value: 'Mae Sai Subdistrict Administrative Organization' },
  { key: 'address',     value: '198 ม.12 ตำบลแม่ใส อำเภอเมืองพะเยา จังหวัดพะเยา 56000' },
  { key: 'phone',       value: '0-5488-9909' },
  { key: 'email',       value: 'saraban_06560115@dla.go.th' },
  { key: 'facebook',    value: 'https://www.facebook.com/MaesaiSAOPhayao' },
  { key: 'lat',         value: '19.1342' },
  { key: 'lng',         value: '99.8814' },
  { key: 'map_zoom',    value: 14 },
  { key: 'mayor_name',  value: 'นาย สันติ สารเร็ว' },
  { key: 'mayor_title', value: 'นายกองค์การบริหารส่วนตำบลแม่ใส' },
  { key: 'mayor_phone', value: '089-757-7366' },
  { key: 'vision',      value: 'ตำบลแม่ใสน่าอยู่ ประชาชนมีคุณภาพชีวิตที่ดี ชุมชนเข้มแข็ง บริหารโปร่งใส ตามหลักธรรมาภิบาล' },
]

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  await mongoose.connect(process.env.MONGO_URI)
  console.log('✅ Connected to MongoDB\n')
  if (FRESH) console.log('  🗑  --fresh: wiping existing ABT data...\n')

  await seed(AbtNews,         news,         'ข่าวสาร')
  await seed(AbtAnnouncement, announcements, 'ประชาสัมพันธ์')
  await seed(AbtProcurement,  procurement,  'จัดซื้อจัดจ้าง')
  await seed(AbtStaff,        staff,        'บุคลากร')
  await seed(AbtTravel,       travel,       'แหล่งท่องเที่ยว')
  await seed(AbtProduct,      products,     'สินค้า OTOP')

  // Settings use upsert so they're always refreshed
  for (const s of settings) {
    await AbtSettings.findOneAndUpdate({ key: s.key }, { value: s.value }, { upsert: true })
  }
  console.log(`  ✅ ตั้งค่าเว็บไซต์: upserted ${settings.length} keys`)

  console.log('\n🎉 Seed complete!\n')
  await mongoose.disconnect()
}

main().catch(err => { console.error('❌ Seed error:', err); process.exit(1) })
