const express = require('express')
const router = express.Router()
const multer = require('multer')
const cloudinary = require('cloudinary').v2
const { CloudinaryStorage } = require('multer-storage-cloudinary')

const AbtNews = require('../models/AbtNews')
const AbtAnnouncement = require('../models/AbtAnnouncement')
const AbtProcurement = require('../models/AbtProcurement')
const AbtStaff = require('../models/AbtStaff')
const AbtTravel = require('../models/AbtTravel')
const AbtProduct = require('../models/AbtProduct')

// ── Cloudinary setup (reuse existing config) ──────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const storage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'abt_maesai', upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET },
})
const upload = multer({ storage })

// ── Image upload endpoint ─────────────────────────────────────────────────────
router.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  res.json({ url: req.file.path })
})

// ═════════════════════════════════════════════════════════════════════════════
// NEWS / ACTIVITIES
// ═════════════════════════════════════════════════════════════════════════════

// GET all news (optional ?dept=council&limit=3)
router.get('/news', async (req, res) => {
  try {
    const filter = { isActive: true }
    if (req.query.dept) filter.department = req.query.dept
    const limit = parseInt(req.query.limit) || 50
    const news = await AbtNews.find(filter).sort({ publishedAt: -1 }).limit(limit)
    res.json(news)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET single news + increment views
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

// POST create news
router.post('/news', async (req, res) => {
  try {
    const item = await AbtNews.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// PUT update news
router.put('/news/:id', async (req, res) => {
  try {
    const item = await AbtNews.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// DELETE news
router.delete('/news/:id', async (req, res) => {
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
    const filter = { isActive: true }
    if (req.query.type) filter.type = req.query.type
    const items = await AbtAnnouncement.find(filter).sort({ publishedAt: -1 })
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/announcements', async (req, res) => {
  try {
    const item = await AbtAnnouncement.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/announcements/:id', async (req, res) => {
  try {
    const item = await AbtAnnouncement.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/announcements/:id', async (req, res) => {
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
    const filter = { isActive: true }
    if (req.query.type) filter.type = req.query.type
    const items = await AbtProcurement.find(filter).sort({ publishedAt: -1 })
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/procurement', async (req, res) => {
  try {
    const item = await AbtProcurement.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/procurement/:id', async (req, res) => {
  try {
    const item = await AbtProcurement.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/procurement/:id', async (req, res) => {
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
    const filter = { isActive: true }
    if (req.query.dept) filter.department = req.query.dept
    const items = await AbtStaff.find(filter).sort({ department: 1, order: 1 })
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/staff', async (req, res) => {
  try {
    const item = await AbtStaff.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/staff/:id', async (req, res) => {
  try {
    const item = await AbtStaff.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/staff/:id', async (req, res) => {
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
    const items = await AbtTravel.find({ isActive: true }).sort({ createdAt: -1 })
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

router.post('/travel', async (req, res) => {
  try {
    const item = await AbtTravel.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/travel/:id', async (req, res) => {
  try {
    const item = await AbtTravel.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/travel/:id', async (req, res) => {
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
    const items = await AbtProduct.find({ isActive: true }).sort({ createdAt: -1 })
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

router.post('/products', async (req, res) => {
  try {
    const item = await AbtProduct.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/products/:id', async (req, res) => {
  try {
    const item = await AbtProduct.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/products/:id', async (req, res) => {
  try {
    await AbtProduct.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router