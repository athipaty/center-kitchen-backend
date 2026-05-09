const express = require('express')
const router = express.Router()
const multer = require('multer')
const cloudinary = require('cloudinary').v2
const { CloudinaryStorage } = require('multer-storage-cloudinary')

const Token = require('../models/Token')
const AbtProcurementPlan = require('../models/AbtProcurementPlan')
const AbtNews = require('../models/AbtNews')
const AbtSettings = require('../models/AbtSettings')
const AbtAnnouncement = require('../models/AbtAnnouncement')
const AbtProcurement = require('../models/AbtProcurement')
const AbtStaff = require('../models/AbtStaff')
const AbtTravel = require('../models/AbtTravel')
const AbtProduct = require('../models/AbtProduct')
const AbtOIT = require('../models/AbtOIT')
const AbtEService = require('../models/AbtEService')
const AbtComplaint = require('../models/AbtComplaint')
const AbtDocument = require('../models/AbtDocument')
const AbtPage     = require('../models/AbtPage')

// ── Cloudinary setup ──────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'abt_maesai',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1200, crop: 'limit' }],
  },
})
const upload = multer({ storage })

const pdfStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'abt_maesai_pdf',
    resource_type: 'raw',
    allowed_formats: ['pdf'],
    format: 'pdf',
  },
})
const uploadPdf = multer({ storage: pdfStorage })

// ── Auth middleware ───────────────────────────────────────────────────────────
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const entry = await Token.findOne({ token })
    if (!entry) return res.status(401).json({ error: 'Invalid token' })
    if (Date.now() > entry.expiry) {
      await Token.deleteOne({ token })
      return res.status(401).json({ error: 'Token expired' })
    }
    next()
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

// ── Image upload ──────────────────────────────────────────────────────────────
router.post('/upload', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  res.json({ url: req.file.path })
})

router.post('/upload-pdf', requireAuth, uploadPdf.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  res.json({ url: req.file.path })
})

// ═════════════════════════════════════════════════════════════════════════════
// NEWS
// ═════════════════════════════════════════════════════════════════════════════

router.get('/news', async (req, res) => {
  try {
    const filter = req.query.all === '1' ? {} : { isActive: true }
    if (req.query.dept) filter.department = req.query.dept
    const limit = parseInt(req.query.limit) || 50
    const news = await AbtNews.find(filter).sort({ publishedAt: -1 }).limit(limit)
    res.json(news)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/news/:id', async (req, res) => {
  try {
    const item = await AbtNews.findByIdAndUpdate(
      req.params.id,
      { $inc: { views: 1 } },
      { new: true }
    )
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/news', requireAuth, async (req, res) => {
  try {
    const item = await AbtNews.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/news/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtNews.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/news/:id', requireAuth, async (req, res) => {
  try {
    await AbtNews.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// ANNOUNCEMENTS
// ═════════════════════════════════════════════════════════════════════════════

router.get('/announcements', async (req, res) => {
  try {
    const filter = req.query.all === '1' ? {} : { isActive: true }
    if (req.query.type) filter.type = req.query.type
    const items = await AbtAnnouncement.find(filter).sort({ publishedAt: -1 })
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/announcements', requireAuth, async (req, res) => {
  try {
    const item = await AbtAnnouncement.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/announcements/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtAnnouncement.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/announcements/:id', requireAuth, async (req, res) => {
  try {
    await AbtAnnouncement.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// PROCUREMENT
// ═════════════════════════════════════════════════════════════════════════════

router.get('/procurement', async (req, res) => {
  try {
    const filter = req.query.all === '1' ? {} : { isActive: true }
    if (req.query.type) filter.type = req.query.type
    const items = await AbtProcurement.find(filter).sort({ publishedAt: -1 })
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/procurement', requireAuth, async (req, res) => {
  try {
    const item = await AbtProcurement.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/procurement/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtProcurement.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/procurement/:id', requireAuth, async (req, res) => {
  try {
    await AbtProcurement.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// e-GP RSS proxy (server-side fetch avoids CORS)
router.get('/egp-rss', async (req, res) => {
  const axios   = require('axios')
  const cheerio = require('cheerio')
  const DEPT_SUB_ID = '6560105'
  const BASE_URL = 'http://process3.gprocurement.go.th/EPROCRssFeedWeb/egpannouncerss.xml'
  try {
    const params = { deptsubId: DEPT_SUB_ID }
    if (req.query.anounceType) params.anounceType = req.query.anounceType
    const { data: xml } = await axios.get(BASE_URL, { params, timeout: 10000 })
    const $ = cheerio.load(xml, { xmlMode: true })
    const items = []
    $('item').each((_, el) => {
      items.push({
        title: $(el).find('title').text(),
        link:  $(el).find('link').text(),
        date:  $(el).find('pubDate').text(),
        desc:  $(el).find('description').text(),
      })
    })
    res.json(items)
  } catch (err) {
    res.status(502).json({ error: 'ไม่สามารถเชื่อมต่อระบบ e-GP ได้: ' + err.message })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// STAFF
// ═════════════════════════════════════════════════════════════════════════════

router.get('/staff', async (req, res) => {
  try {
    const filter = req.query.all === '1' ? {} : { isActive: true }
    if (req.query.dept) filter.department = req.query.dept
    const items = await AbtStaff.find(filter).sort({ department: 1, order: 1 })
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/staff', requireAuth, async (req, res) => {
  try {
    if (!req.body.isVacant && !req.body.name?.trim())
      return res.status(400).json({ error: 'กรุณากรอกชื่อ-นามสกุล' })
    const item = await AbtStaff.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/staff/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtStaff.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/staff/:id', requireAuth, async (req, res) => {
  try {
    await AbtStaff.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// TRAVEL
// ═════════════════════════════════════════════════════════════════════════════

router.get('/travel', async (req, res) => {
  try {
    const filter = req.query.all === '1' ? {} : { isActive: true }
    const items = await AbtTravel.find(filter).sort({ createdAt: -1 })
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/travel/:id', async (req, res) => {
  try {
    const item = await AbtTravel.findByIdAndUpdate(
      req.params.id, { $inc: { views: 1 } }, { new: true }
    )
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/travel', requireAuth, async (req, res) => {
  try {
    const item = await AbtTravel.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/travel/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtTravel.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/travel/:id', requireAuth, async (req, res) => {
  try {
    await AbtTravel.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// PRODUCTS (OTOP)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/products', async (req, res) => {
  try {
    const filter = req.query.all === '1' ? {} : { isActive: true }
    const items = await AbtProduct.find(filter).sort({ createdAt: -1 })
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/products/:id', async (req, res) => {
  try {
    const item = await AbtProduct.findByIdAndUpdate(
      req.params.id, { $inc: { views: 1 } }, { new: true }
    )
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/products', requireAuth, async (req, res) => {
  try {
    const item = await AbtProduct.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/products/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtProduct.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/products/:id', requireAuth, async (req, res) => {
  try {
    await AbtProduct.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═════════════════════════════════════════════════════════════════════════════

router.get('/settings', async (req, res) => {
  try {
    const items = await AbtSettings.find()
    const result = {}
    items.forEach(item => { result[item.key] = item.value })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/settings/:key', requireAuth, async (req, res) => {
  try {
    const item = await AbtSettings.findOneAndUpdate(
      { key: req.params.key },
      { value: req.body.value },
      { new: true, upsert: true }
    )
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// PROCUREMENT PLANS
// ═════════════════════════════════════════════════════════════════════════════

router.get('/procurement-plans', async (req, res) => {
  try {
    const filter = req.query.all === '1' ? {} : { isActive: true }
    const items = await AbtProcurementPlan.find(filter).sort({ year: -1, publishedAt: -1 })
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/procurement-plans', requireAuth, async (req, res) => {
  try {
    const item = await AbtProcurementPlan.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/procurement-plans/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtProcurementPlan.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/procurement-plans/:id', requireAuth, async (req, res) => {
  try {
    await AbtProcurementPlan.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// ITA / OIT
// ═════════════════════════════════════════════════════════════════════════════

router.get('/oit', async (req, res) => {
  try {
    const filter = {}
    if (req.query.year) filter.fiscalYear = req.query.year
    const items = await AbtOIT.find(filter).sort({ fiscalYear: -1, itemNo: 1 })
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/oit/years', async (req, res) => {
  try {
    const years = await AbtOIT.distinct('fiscalYear')
    res.json(years.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/oit', requireAuth, async (req, res) => {
  try {
    const item = await AbtOIT.findOneAndUpdate(
      { fiscalYear: req.body.fiscalYear, itemNo: req.body.itemNo },
      req.body,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    )
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/oit/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtOIT.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/oit/:id', requireAuth, async (req, res) => {
  try {
    await AbtOIT.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// E-SERVICE
// ═════════════════════════════════════════════════════════════════════════════

function genRequestNo(prefix) {
  const now = new Date()
  const y = String(now.getFullYear() + 543).slice(2)
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const rand = String(Math.floor(Math.random() * 9000) + 1000)
  return `${prefix}${y}${m}${rand}`
}

router.get('/eservice', requireAuth, async (req, res) => {
  try {
    const filter = {}
    if (req.query.status) filter.status = req.query.status
    if (req.query.type) filter.type = req.query.type
    const items = await AbtEService.find(filter).sort({ createdAt: -1 }).limit(200)
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/eservice/track/:requestNo', async (req, res) => {
  try {
    const item = await AbtEService.findOne({ requestNo: req.params.requestNo })
    if (!item) return res.status(404).json({ error: 'ไม่พบเลขที่คำร้อง' })
    res.json(item)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/eservice', async (req, res) => {
  try {
    const requestNo = genRequestNo('ES')
    const item = await AbtEService.create({ ...req.body, requestNo })
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/eservice/:id', requireAuth, async (req, res) => {
  try {
    const update = { ...req.body }
    if (update.status === 'done' || update.status === 'rejected') update.closedAt = new Date()
    const item = await AbtEService.findByIdAndUpdate(req.params.id, update, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// COMPLAINTS
// ═════════════════════════════════════════════════════════════════════════════

router.get('/complaints', requireAuth, async (req, res) => {
  try {
    const filter = {}
    if (req.query.type) filter.type = req.query.type
    if (req.query.status) filter.status = req.query.status
    const items = await AbtComplaint.find(filter).sort({ createdAt: -1 }).limit(200)
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/complaints/track/:complaintNo', async (req, res) => {
  try {
    const item = await AbtComplaint.findOne({ complaintNo: req.params.complaintNo })
    if (!item) return res.status(404).json({ error: 'ไม่พบเลขที่เรื่องร้องเรียน' })
    res.json(item)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/complaints', async (req, res) => {
  try {
    const complaintNo = genRequestNo('CP')
    const item = await AbtComplaint.create({ ...req.body, complaintNo })
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/complaints/:id', requireAuth, async (req, res) => {
  try {
    const update = { ...req.body }
    if (update.status === 'done' || update.status === 'rejected') update.closedAt = new Date()
    const item = await AbtComplaint.findByIdAndUpdate(req.params.id, update, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// DOCUMENTS
// ═════════════════════════════════════════════════════════════════════════════

router.get('/documents', async (req, res) => {
  try {
    const filter = req.query.all === '1' ? {} : { isActive: true }
    if (req.query.category) filter.category = req.query.category
    if (req.query.year) filter.fiscalYear = req.query.year
    const items = await AbtDocument.find(filter).sort({ publishedAt: -1 })
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/documents', requireAuth, async (req, res) => {
  try {
    const item = await AbtDocument.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/documents/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtDocument.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/documents/:id', requireAuth, async (req, res) => {
  try {
    await AbtDocument.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// PAGES / MENU
// ═════════════════════════════════════════════════════════════════════════════

const NAVBAR_SLUGS = ['builtin-about','builtin-staff','builtin-eservice','builtin-complaint','builtin-corruption','builtin-contact']

const DEFAULT_MENU = [
  { title: 'เกี่ยวกับ อบต.แม่ใส',             slug: 'builtin-about',       icon: '🏛️', path: '/about',          isBuiltin: true, order: 0,  showInNavbar: true  },
  { title: 'ข่าวสาร/ประชาสัมพันธ์',            slug: 'builtin-news',        icon: '📰', path: '/news',           isBuiltin: true, order: 1,  showInNavbar: false },
  { title: 'การเงิน/การคลัง',                  slug: 'builtin-finance',     icon: '💰', path: '/finance',        isBuiltin: true, order: 3,  showInNavbar: false },
  { title: 'จัดซื้อจัดจ้าง',                   slug: 'builtin-procurement', icon: '📋', path: '/procurement',    isBuiltin: true, order: 4,  showInNavbar: false },
  { title: 'บุคลากร',                           slug: 'builtin-staff',       icon: '👥', path: '/staff',          isBuiltin: true, order: 5,  showInNavbar: true  },
  { title: 'บริการสาธารณะ',                    slug: 'builtin-public',      icon: '🌐', path: '/public-service', isBuiltin: true, order: 6,  showInNavbar: false },
  { title: 'e-Service',                        slug: 'builtin-eservice',    icon: '🌐', path: '/eservice',       isBuiltin: true, order: 7,  showInNavbar: true  },
  { title: 'ร้องเรียน/ร้องทุกข์',              slug: 'builtin-complaint',   icon: '📮', path: '/complaint',      isBuiltin: true, order: 8,  showInNavbar: true  },
  { title: 'ร้องเรียนการทุจริตและประพฤติมิชอบ', slug: 'builtin-corruption',  icon: '🚨', path: '/corruption',     isBuiltin: true, order: 9,  showInNavbar: true  },
  { title: 'ITA/OIT',                          slug: 'builtin-ita',         icon: '📝', path: '/ita',            isBuiltin: true, order: 10, showInNavbar: false },
  { title: 'ศูนย์ข้อมูลข่าวสาร',               slug: 'builtin-info',        icon: '📚', path: '/info-center',    isBuiltin: true, order: 11, showInNavbar: false },
  { title: 'กฎหมาย/ข้อบัญญัติ',                slug: 'builtin-laws',        icon: '⚖️', path: '/laws',           isBuiltin: true, order: 12, showInNavbar: false },
  { title: 'ติดต่อเรา',                        slug: 'builtin-contact',     icon: '📞', path: '/contact',        isBuiltin: true, order: 13, showInNavbar: true  },
]

router.get('/pages', async (req, res) => {
  try {
    let pages = await AbtPage.find().sort({ order: 1, createdAt: 1 })
    if (pages.length === 0) {
      pages = await AbtPage.insertMany(DEFAULT_MENU)
    } else {
      // Migrate: ensure navbar built-in pages have showInNavbar set correctly
      await AbtPage.updateMany({ slug: { $in: NAVBAR_SLUGS }, showInNavbar: { $ne: true } }, { $set: { showInNavbar: true } })
      // Rename staff page title
      await AbtPage.updateOne({ slug: 'builtin-staff', title: 'บุคลากร/กิจการสภา' }, { $set: { title: 'บุคลากร' } })
      // Permanently remove development plan page
      await AbtPage.deleteOne({ slug: 'builtin-plan' })
      // Ensure eservice entry exists
      const hasEservice = pages.some(p => p.slug === 'builtin-eservice')
      if (!hasEservice) {
        await AbtPage.create({ title: 'e-Service', slug: 'builtin-eservice', icon: '🌐', path: '/eservice', isBuiltin: true, order: 7, showInNavbar: true })
      }
      pages = await AbtPage.find().sort({ order: 1, createdAt: 1 })
    }
    res.json(pages)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/pages/slug/:slug', async (req, res) => {
  try {
    const page = await AbtPage.findOne({ slug: req.params.slug, isActive: true })
    if (!page) return res.status(404).json({ error: 'ไม่พบหน้านี้' })
    res.json(page)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/pages', requireAuth, async (req, res) => {
  try {
    const page = await AbtPage.create(req.body)
    res.status(201).json(page)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/pages/:id', requireAuth, async (req, res) => {
  try {
    const page = await AbtPage.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!page) return res.status(404).json({ error: 'Not found' })
    res.json(page)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/pages/:id', requireAuth, async (req, res) => {
  try {
    const page = await AbtPage.findById(req.params.id)
    if (!page) return res.status(404).json({ error: 'Not found' })
    if (page.isBuiltin) return res.status(400).json({ error: 'ไม่สามารถลบหน้าระบบได้' })
    await AbtPage.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
