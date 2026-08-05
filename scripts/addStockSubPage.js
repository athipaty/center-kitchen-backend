// Registers the new "บัญชีวัสดุไฟฟ้า" React page as a child of the existing กองช่าง page.
require('dotenv').config()
const mongoose = require('mongoose')
const AbtPage = require('../models/abt/AbtPage')

const PARENT_SLUG = 'page-1778827535036' // กองช่าง

async function main() {
  await mongoose.connect(process.env.MONGO_URI)

  const exists = await AbtPage.findOne({ path: '/stock/electrical' })
  if (exists) {
    console.log('Page already exists:', exists.slug)
    await mongoose.disconnect()
    return
  }

  const doc = await AbtPage.create({
    title: 'บัญชีวัสดุไฟฟ้า',
    slug: `page-${Date.now()}`,
    icon: '📦',
    parentSlug: PARENT_SLUG,
    order: 20,
    isActive: true,
    isBuiltin: true,
    showInNavbar: false,
    path: '/stock/electrical',
    blocks: [],
  })
  console.log('Created page:', doc.slug, doc._id.toString())

  await mongoose.disconnect()
}

main().catch(err => { console.error(err); process.exit(1) })
