require('dotenv').config()
const mongoose = require('mongoose')
const AbtOIT = require('../models/AbtOIT')

const FISCAL_YEAR = process.argv[2] || '2568'

const OIT_ITEMS = [
  { itemNo: 1,  title: 'โครงสร้าง',                                                       category: 'ข้อมูลพื้นฐาน' },
  { itemNo: 2,  title: 'ข้อมูลผู้บริหาร',                                                  category: 'ข้อมูลพื้นฐาน' },
  { itemNo: 3,  title: 'อำนาจหน้าที่',                                                      category: 'ข้อมูลพื้นฐาน' },
  { itemNo: 4,  title: 'ข้อมูลการติดต่อ',                                                  category: 'ข้อมูลพื้นฐาน' },
  { itemNo: 5,  title: 'ข่าวประชาสัมพันธ์',                                                category: 'ข้อมูลพื้นฐาน' },
  { itemNo: 6,  title: 'Q&A',                                                              category: 'ข้อมูลพื้นฐาน' },
  { itemNo: 7,  title: 'Social Network',                                                   category: 'ข้อมูลพื้นฐาน' },
  { itemNo: 8,  title: 'นโยบายคุ้มครองข้อมูลส่วนบุคคล',                                   category: 'ข้อมูลพื้นฐาน' },
  { itemNo: 9,  title: 'แผนดำเนินงานและการใช้งบประมาณประจำปี',                             category: 'การบริหารงาน' },
  { itemNo: 10, title: 'รายงานการกำกับติดตามการดำเนินงานและการใช้งบประมาณ รอบ 6 เดือน',   category: 'การบริหารงาน' },
  { itemNo: 11, title: 'รายงานผลการดำเนินงานประจำปี',                                      category: 'การบริหารงาน' },
  { itemNo: 12, title: 'คู่มือหรือมาตรฐานการปฏิบัติงาน',                                  category: 'การบริหารงาน' },
  { itemNo: 13, title: 'คู่มือหรือมาตรฐานการให้บริการ',                                    category: 'การบริหารงาน' },
  { itemNo: 14, title: 'ข้อมูลเชิงสถิติการให้บริการ',                                      category: 'การบริหารงาน' },
  { itemNo: 15, title: 'รายงานผลการสำรวจความพึงพอใจการให้บริการ',                          category: 'การบริหารงาน' },
  { itemNo: 16, title: 'E-Service',                                                        category: 'การบริหารงาน' },
  { itemNo: 17, title: 'แผนการจัดซื้อจัดจ้างหรือแผนการจัดหาพัสดุ',                       category: 'การจัดซื้อจัดจ้าง' },
  { itemNo: 18, title: 'ประกาศต่าง ๆ เกี่ยวกับการจัดซื้อจัดจ้างหรือการจัดหาพัสดุ',       category: 'การจัดซื้อจัดจ้าง' },
  { itemNo: 19, title: 'ความก้าวหน้าการจัดซื้อจัดจ้างหรือการจัดหาพัสดุ',                 category: 'การจัดซื้อจัดจ้าง' },
  { itemNo: 20, title: 'รายงานสรุปผลการจัดซื้อจัดจ้างหรือการจัดหาพัสดุประจำปี',          category: 'การจัดซื้อจัดจ้าง' },
  { itemNo: 21, title: 'นโยบายหรือแผนการบริหารทรัพยากรบุคคล',                             category: 'การบริหารทรัพยากรบุคคล' },
  { itemNo: 22, title: 'การดำเนินการตามนโยบายหรือแผนการบริหารทรัพยากรบุคคล',             category: 'การบริหารทรัพยากรบุคคล' },
  { itemNo: 23, title: 'หลักเกณฑ์การบริหารและพัฒนาทรัพยากรบุคคล',                         category: 'การบริหารทรัพยากรบุคคล' },
  { itemNo: 24, title: 'รายงานผลการบริหารและพัฒนาทรัพยากรบุคคลประจำปี',                  category: 'การบริหารทรัพยากรบุคคล' },
  { itemNo: 25, title: 'แนวปฏิบัติการจัดการเรื่องร้องเรียนการทุจริตและประพฤติมิชอบ',      category: 'ส่งเสริมความโปร่งใส' },
  { itemNo: 26, title: 'ช่องทางแจ้งเรื่องร้องเรียนการทุจริตและประพฤติมิชอบ',              category: 'ส่งเสริมความโปร่งใส' },
]

async function seed() {
  await mongoose.connect(process.env.MONGO_URI)
  console.log(`✅ Connected — seeding OIT for ปีงบประมาณ ${FISCAL_YEAR}`)

  for (const item of OIT_ITEMS) {
    const exists = await AbtOIT.findOne({ fiscalYear: FISCAL_YEAR, itemNo: item.itemNo })
    if (exists) {
      console.log(`⏭  ข้าม O${String(item.itemNo).padStart(2,'0')} (มีอยู่แล้ว)`)
      continue
    }
    await AbtOIT.create({ ...item, fiscalYear: FISCAL_YEAR, status: 'pending' })
    console.log(`✅ สร้าง O${String(item.itemNo).padStart(2,'0')}: ${item.title}`)
  }

  await mongoose.disconnect()
  console.log('🎉 เสร็จแล้ว!')
}

seed().catch(err => { console.error(err); process.exit(1) })
