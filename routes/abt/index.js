const express = require('express')
const router = express.Router()
const multer = require('multer')
const cloudinary = require('cloudinary').v2
const { CloudinaryStorage } = require('multer-storage-cloudinary')
const { S3Client } = require('@aws-sdk/client-s3')
const multerS3 = require('multer-s3')

const Token = require('../../models/shared/Token')
const AbtProcurementPlan = require('../../models/abt/AbtProcurementPlan')
const AbtNews = require('../../models/abt/AbtNews')
const AbtSettings = require('../../models/abt/AbtSettings')
const AbtAnnouncement = require('../../models/abt/AbtAnnouncement')
const AbtProcurement = require('../../models/abt/AbtProcurement')
const AbtStaff = require('../../models/abt/AbtStaff')
const AbtTravel = require('../../models/abt/AbtTravel')
const AbtProduct = require('../../models/abt/AbtProduct')
const AbtOIT = require('../../models/abt/AbtOIT')
const AbtEService = require('../../models/abt/AbtEService')
const AbtEServiceType = require('../../models/abt/AbtEServiceType')
const AbtComplaint = require('../../models/abt/AbtComplaint')
const AbtDocument = require('../../models/abt/AbtDocument')
const AbtPage     = require('../../models/abt/AbtPage')
const AbtVisitor  = require('../../models/abt/AbtVisitor')

// â”€â”€ Cloudinary setup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

let _uploadPdf = null
function getUploadPdf() {
  if (!_uploadPdf) {
    const { B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_REGION } = process.env
    if (!B2_KEY_ID || !B2_APP_KEY || !B2_BUCKET || !B2_REGION) {
      throw new Error('B2 env vars not set (B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_REGION)')
    }
    const b2Client = new S3Client({
      endpoint: `https://s3.${B2_REGION}.backblazeb2.com`,
      region: B2_REGION,
      credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APP_KEY },
      forcePathStyle: true,
    })
    _uploadPdf = multer({
      storage: multerS3({
        s3: b2Client,
        bucket: B2_BUCKET,
        acl: (_req, _file, cb) => cb(null, undefined),
        contentType: (_req, _file, cb) => cb(null, 'application/pdf'),
        contentDisposition: (_req, _file, cb) => cb(null, 'inline'),
        key: (req, file, cb) => {
          const safe = file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '')
          cb(null, `pdfs/${Date.now()}-${safe}`)
        },
      }),
      limits: { fileSize: 100 * 1024 * 1024 },
      fileFilter: (_, file, cb) => {
        file.mimetype === 'application/pdf' ? cb(null, true) : cb(new Error('PDF only'))
      },
    })
  }
  return _uploadPdf
}

const excelStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'abt_maesai_excel',
    resource_type: 'raw',
    allowed_formats: ['xlsx', 'xls'],
  },
})
const uploadExcel = multer({ storage: excelStorage })

// â”€â”€ Auth middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Image upload â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/upload', requireAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  res.json({ url: req.file.path })
})

router.post('/upload-pdf', requireAuth, (req, res, next) => {
  try {
    getUploadPdf().single('pdf')(req, res, (err) => {
      if (err) {
        console.error('[B2 PDF upload error]', err)
        return res.status(500).json({ error: err.message || 'Upload failed', detail: err.Code || err.code || '' })
      }
      next()
    })
  } catch (err) {
    console.error('[B2 init error]', err)
    res.status(500).json({ error: err.message })
  }
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  res.json({ url: req.file.location })
})

router.post('/upload-excel', requireAuth, uploadExcel.single('excel'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  res.json({ url: req.file.path })
})

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// NEWS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ANNOUNCEMENTS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PROCUREMENT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
    res.status(502).json({ error: 'à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¹€à¸Šà¸·à¹ˆà¸­à¸¡à¸•à¹ˆà¸­à¸£à¸°à¸šà¸š e-GP à¹„à¸”à¹‰: ' + err.message })
  }
})

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STAFF
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
      return res.status(400).json({ error: 'à¸à¸£à¸¸à¸“à¸²à¸à¸£à¸­à¸à¸Šà¸·à¹ˆà¸­-à¸™à¸²à¸¡à¸ªà¸à¸¸à¸¥' })
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// TRAVEL
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PRODUCTS (OTOP)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SETTINGS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PROCUREMENT PLANS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ITA / OIT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// E-SERVICE TYPES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const DEFAULT_ESERVICE_TYPES = [
  { value: 'general',      label: 'à¸„à¸³à¸£à¹‰à¸­à¸‡à¸—à¸±à¹ˆà¸§à¹„à¸›',         icon: 'ðŸ“', order: 0 },
  { value: 'road',         label: 'à¹à¸ˆà¹‰à¸‡à¸‹à¹ˆà¸­à¸¡à¸–à¸™à¸™/à¸—à¸²à¸‡à¹€à¸—à¹‰à¸²',  icon: 'ðŸ›£ï¸', order: 1 },
  { value: 'street_light', label: 'à¹à¸ˆà¹‰à¸‡à¸‹à¹ˆà¸­à¸¡à¹„à¸Ÿà¸Ÿà¹‰à¸²à¸ªà¸²à¸˜à¸²à¸£à¸“à¸°', icon: 'ðŸ’¡', order: 2 },
  { value: 'water',        label: 'à¹à¸ˆà¹‰à¸‡à¸›à¸±à¸à¸«à¸²à¸™à¹‰à¸³à¸›à¸£à¸°à¸›à¸²',     icon: 'ðŸ’§', order: 3 },
  { value: 'garbage',      label: 'à¸‚à¸­à¸–à¸±à¸‡à¸‚à¸¢à¸°/à¹€à¸à¹‡à¸šà¸‚à¸¢à¸°',      icon: 'ðŸ—‘ï¸', order: 4 },
  { value: 'noise',        label: 'à¸£à¹‰à¸­à¸‡à¹€à¸£à¸µà¸¢à¸™à¹€à¸ªà¸µà¸¢à¸‡à¸£à¸šà¸à¸§à¸™',   icon: 'ðŸ“¢', order: 5 },
  { value: 'other',        label: 'à¸­à¸·à¹ˆà¸™ à¹†',                icon: 'â“', order: 6 },
]

router.get('/eservice-types', async (req, res) => {
  try {
    let types = await AbtEServiceType.find().sort({ order: 1, createdAt: 1 })
    if (types.length === 0) {
      types = await AbtEServiceType.insertMany(DEFAULT_ESERVICE_TYPES)
    }
    res.json(types)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/eservice-types', requireAuth, async (req, res) => {
  try {
    const count = await AbtEServiceType.countDocuments()
    const value = req.body.value || `type_${Date.now()}`
    const item = await AbtEServiceType.create({ ...req.body, value, order: req.body.order ?? count * 10 })
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/eservice-types/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtEServiceType.findByIdAndUpdate(req.params.id, req.body, { new: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/eservice-types/:id', requireAuth, async (req, res) => {
  try {
    await AbtEServiceType.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// E-SERVICE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
    if (!item) return res.status(404).json({ error: 'à¹„à¸¡à¹ˆà¸žà¸šà¹€à¸¥à¸‚à¸—à¸µà¹ˆà¸„à¸³à¸£à¹‰à¸­à¸‡' })
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// COMPLAINTS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
    if (!item) return res.status(404).json({ error: 'à¹„à¸¡à¹ˆà¸žà¸šà¹€à¸¥à¸‚à¸—à¸µà¹ˆà¹€à¸£à¸·à¹ˆà¸­à¸‡à¸£à¹‰à¸­à¸‡à¹€à¸£à¸µà¸¢à¸™' })
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// DOCUMENTS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PAGES / MENU
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const DEFAULT_MENU = [
  { title: 'à¹€à¸à¸µà¹ˆà¸¢à¸§à¸à¸±à¸š à¸­à¸šà¸•.à¹à¸¡à¹ˆà¹ƒà¸ª',             slug: 'builtin-about',       icon: 'ðŸ›ï¸', path: '/about',          isBuiltin: true, order: 0,  showInNavbar: true  },
  { title: 'à¸‚à¹ˆà¸²à¸§à¸ªà¸²à¸£/à¸›à¸£à¸°à¸Šà¸²à¸ªà¸±à¸¡à¸žà¸±à¸™à¸˜à¹Œ',            slug: 'builtin-news',        icon: 'ðŸ“°', path: '/news',           isBuiltin: true, order: 1,  showInNavbar: false },
  { title: 'à¸à¸²à¸£à¹€à¸‡à¸´à¸™/à¸à¸²à¸£à¸„à¸¥à¸±à¸‡',                  slug: 'builtin-finance',     icon: 'ðŸ’°', path: '/finance',        isBuiltin: true, order: 3,  showInNavbar: false },
  { title: 'à¸ˆà¸±à¸”à¸‹à¸·à¹‰à¸­à¸ˆà¸±à¸”à¸ˆà¹‰à¸²à¸‡',                   slug: 'builtin-procurement', icon: 'ðŸ“‹', path: '/procurement',    isBuiltin: true, order: 4,  showInNavbar: false },
  { title: 'à¸šà¸¸à¸„à¸¥à¸²à¸à¸£',                           slug: 'builtin-staff',       icon: 'ðŸ‘¥', path: '/staff',          isBuiltin: true, order: 5,  showInNavbar: true  },
  { title: 'à¸šà¸£à¸´à¸à¸²à¸£à¸ªà¸²à¸˜à¸²à¸£à¸“à¸°',                    slug: 'builtin-public',      icon: 'ðŸŒ', path: '/public-service', isBuiltin: true, order: 6,  showInNavbar: false },
  { title: 'e-Service',                        slug: 'builtin-eservice',    icon: 'ðŸŒ', path: '/eservice',       isBuiltin: true, order: 7,  showInNavbar: true  },
  { title: 'à¸£à¹‰à¸­à¸‡à¹€à¸£à¸µà¸¢à¸™/à¸£à¹‰à¸­à¸‡à¸—à¸¸à¸à¸‚à¹Œ',              slug: 'builtin-complaint',   icon: 'ðŸ“®', path: '/complaint',      isBuiltin: true, order: 8,  showInNavbar: true  },
  { title: 'à¸£à¹‰à¸­à¸‡à¹€à¸£à¸µà¸¢à¸™à¸à¸²à¸£à¸—à¸¸à¸ˆà¸£à¸´à¸•à¹à¸¥à¸°à¸›à¸£à¸°à¸žà¸¤à¸•à¸´à¸¡à¸´à¸Šà¸­à¸š', slug: 'builtin-corruption',  icon: 'ðŸš¨', path: '/corruption',     isBuiltin: true, order: 9,  showInNavbar: true  },
  { title: 'ITA/OIT',                          slug: 'builtin-ita',         icon: 'ðŸ“', path: '/ita',            isBuiltin: true, order: 10, showInNavbar: false },
  { title: 'à¸¨à¸¹à¸™à¸¢à¹Œà¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸‚à¹ˆà¸²à¸§à¸ªà¸²à¸£',               slug: 'builtin-info',        icon: 'ðŸ“š', path: '/info-center',    isBuiltin: true, order: 11, showInNavbar: false },
  { title: 'à¸à¸Žà¸«à¸¡à¸²à¸¢/à¸‚à¹‰à¸­à¸šà¸±à¸à¸à¸±à¸•à¸´',                slug: 'builtin-laws',        icon: 'âš–ï¸', path: '/laws',           isBuiltin: true, order: 12, showInNavbar: false },
  { title: 'à¸•à¸´à¸”à¸•à¹ˆà¸­à¹€à¸£à¸²',                        slug: 'builtin-contact',     icon: 'ðŸ“ž', path: '/contact',        isBuiltin: true, order: 13, showInNavbar: true  },
  { title: 'à¸ªà¸´à¸™à¸„à¹‰à¸² OTOP',                     slug: 'builtin-products',    icon: 'ðŸ›ï¸', path: '/products',       isBuiltin: true, order: 14, showInNavbar: false },
  { title: 'à¹à¸«à¸¥à¹ˆà¸‡à¸—à¹ˆà¸­à¸‡à¹€à¸—à¸µà¹ˆà¸¢à¸§',                  slug: 'builtin-travel',      icon: 'ðŸ—ºï¸', path: '/travel',         isBuiltin: true, order: 15, showInNavbar: false },
]

router.get('/pages', async (req, res) => {
  try {
    let pages = await AbtPage.find().sort({ order: 1, createdAt: 1 })
    if (pages.length === 0) {
      pages = await AbtPage.insertMany(DEFAULT_MENU)
    } else {
      // Rename staff page title
      await AbtPage.updateOne({ slug: 'builtin-staff', title: 'à¸šà¸¸à¸„à¸¥à¸²à¸à¸£/à¸à¸´à¸ˆà¸à¸²à¸£à¸ªà¸ à¸²' }, { $set: { title: 'à¸šà¸¸à¸„à¸¥à¸²à¸à¸£' } })
      // Permanently remove development plan page
      await AbtPage.deleteOne({ slug: 'builtin-plan' })
      // Ensure eservice entry exists
      const hasEservice = pages.some(p => p.slug === 'builtin-eservice')
      if (!hasEservice) {
        await AbtPage.create({ title: 'e-Service', slug: 'builtin-eservice', icon: 'ðŸŒ', path: '/eservice', isBuiltin: true, order: 7, showInNavbar: true })
      }
      if (!pages.some(p => p.slug === 'builtin-products')) {
        await AbtPage.create({ title: 'à¸ªà¸´à¸™à¸„à¹‰à¸² OTOP', slug: 'builtin-products', icon: 'ðŸ›ï¸', path: '/products', isBuiltin: true, order: 14, showInNavbar: false })
      }
      if (!pages.some(p => p.slug === 'builtin-travel')) {
        await AbtPage.create({ title: 'à¹à¸«à¸¥à¹ˆà¸‡à¸—à¹ˆà¸­à¸‡à¹€à¸—à¸µà¹ˆà¸¢à¸§', slug: 'builtin-travel', icon: 'ðŸ—ºï¸', path: '/travel', isBuiltin: true, order: 15, showInNavbar: false })
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
    if (!page) return res.status(404).json({ error: 'à¹„à¸¡à¹ˆà¸žà¸šà¸«à¸™à¹‰à¸²à¸™à¸µà¹‰' })
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
    if (page.isBuiltin) return res.status(400).json({ error: 'à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¸¥à¸šà¸«à¸™à¹‰à¸²à¸£à¸°à¸šà¸šà¹„à¸”à¹‰' })
    await AbtPage.findByIdAndDelete(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// VISITOR COUNTER
// ═══════════════════════════════════════════════════════════════════════════════

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

router.get('/visits', async (req, res) => {
  try {
    const today = todayStr()
    const [todayDoc, agg] = await Promise.all([
      AbtVisitor.findOne({ date: today }),
      AbtVisitor.aggregate([{ $group: { _id: null, total: { $sum: '$count' } } }]),
    ])
    res.json({ today: todayDoc?.count || 0, total: agg[0]?.total || 0 })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/visits', async (req, res) => {
  try {
    const today = todayStr()
    const doc = await AbtVisitor.findOneAndUpdate(
      { date: today },
      { $inc: { count: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    )
    const agg = await AbtVisitor.aggregate([{ $group: { _id: null, total: { $sum: '$count' } } }])
    res.json({ today: doc.count, total: agg[0]?.total || 0 })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router


