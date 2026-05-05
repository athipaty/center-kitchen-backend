const express = require('express')
const router = express.Router()
const multer = require('multer')
const cloudinary = require('cloudinary').v2
const { CloudinaryStorage } = require('multer-storage-cloudinary')

const Token = require('../models/Token')
const AbtNews = require('../models/AbtNews')
const AbtSettings = require('../models/AbtSettings')
const AbtAnnouncement = require('../models/AbtAnnouncement')
const AbtProcurement = require('../models/AbtProcurement')
const AbtStaff = require('../models/AbtStaff')
const AbtTravel = require('../models/AbtTravel')
const AbtProduct = require('../models/AbtProduct')

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
    if (entry.ip !== getClientIp(req)) return res.status(401).json({ error: 'IP mismatch' })
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

module.exports = router
