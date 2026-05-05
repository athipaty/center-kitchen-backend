require('dotenv').config()
const mongoose = require('mongoose')
const AbtProcurementPlan = require('../models/AbtProcurementPlan')

const BASE_ZIP = 'https://maesaiphayao.go.th/maesaisao/dowload/file-upload/s01/' +
  '%e0%b9%81%e0%b8%9c%e0%b8%99%e0%b8%88%e0%b8%b1%e0%b8%94%e0%b8%ab%e0%b8%b2%e0%b8%9e%e0%b8%b1%e0%b8%aa%e0%b8%94%e0%b8%b8%20' +
  '(%e0%b8%9c%e0%b8%94.2)%20%e0%b8%9b%e0%b8%b5%20'

const PLANS = [
  {
    year: '2567',
    title: 'รายงานการจัดซื้อจัดจ้างหรือการจัดหาพัสดุ ประจำปีงบประมาณ พ.ศ. 2567 (Open Data)',
    fileUrl: 'https://maesaiphayao.go.th/userfiles/files/%E0%B8%87%E0%B8%B2%E0%B8%99%E0%B8%9E%E0%B8%B1%E0%B8%AA%E0%B8%94%E0%B8%B8/O14-%E0%B8%A3%E0%B8%B2%E0%B8%A2%E0%B8%87%E0%B8%B2%E0%B8%99%E0%B8%81%E0%B8%B2%E0%B8%A3%E0%B8%88%E0%B8%B1%E0%B8%94%E0%B8%8B%E0%B8%B7%E0%B9%89%E0%B8%AD%E0%B8%88%E0%B8%B1%E0%B8%94%E0%B8%88%E0%B9%89%E0%B8%B2%E0%B8%87%E0%B8%AB%E0%B8%A3%E0%B8%B7%E0%B8%AD%E0%B8%81%E0%B8%B2%E0%B8%A3%E0%B8%88%E0%B8%B1%E0%B8%94%E0%B8%AB%E0%B8%B2%E0%B8%9E%E0%B8%B1%E0%B8%AA%E0%B8%94%E0%B8%B8%20%E0%B8%9B%E0%B8%B52567.xls',
    fileType: 'excel',
  },
  { year: '2560', title: 'แผนจัดหาพัสดุ (ผด.2) ประจำปีงบประมาณ พ.ศ. 2560', fileUrl: BASE_ZIP + '60.zip', fileType: 'zip' },
  { year: '2559', title: 'แผนจัดหาพัสดุ (ผด.2) ประจำปีงบประมาณ พ.ศ. 2559', fileUrl: BASE_ZIP + '59.zip', fileType: 'zip' },
  { year: '2558', title: 'แผนจัดหาพัสดุ (ผด.2) ประจำปีงบประมาณ พ.ศ. 2558', fileUrl: BASE_ZIP + '58.zip', fileType: 'zip' },
  { year: '2557', title: 'แผนจัดหาพัสดุ (ผด.2) ประจำปีงบประมาณ พ.ศ. 2557', fileUrl: BASE_ZIP + '57.zip', fileType: 'zip' },
  { year: '2556', title: 'แผนจัดหาพัสดุ (ผด.2) ประจำปีงบประมาณ พ.ศ. 2556', fileUrl: BASE_ZIP + '56.zip', fileType: 'zip' },
  { year: '2555', title: 'แผนจัดหาพัสดุ (ผด.2) ประจำปีงบประมาณ พ.ศ. 2555', fileUrl: BASE_ZIP + '55.zip', fileType: 'zip' },
  { year: '2554', title: 'แผนจัดหาพัสดุ (ผด.2) ประจำปีงบประมาณ พ.ศ. 2554', fileUrl: BASE_ZIP + '54.zip', fileType: 'zip' },
]

async function seed() {
  await mongoose.connect(process.env.MONGO_URI)
  console.log('✅ Connected to MongoDB')

  for (const plan of PLANS) {
    const exists = await AbtProcurementPlan.findOne({ year: plan.year, title: plan.title })
    if (exists) {
      console.log(`⏭  ข้ามปี ${plan.year} (มีอยู่แล้ว)`)
      continue
    }
    await AbtProcurementPlan.create({ ...plan, isActive: true })
    console.log(`✅ เพิ่มปี ${plan.year}: ${plan.title}`)
  }

  await mongoose.disconnect()
  console.log('🎉 เสร็จแล้ว!')
}

seed().catch(err => { console.error(err); process.exit(1) })
