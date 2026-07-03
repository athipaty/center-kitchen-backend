const express = require('express')
const crypto  = require('crypto')
const router  = express.Router()
const multer = require('multer')
const { S3Client } = require('@aws-sdk/client-s3')
const multerS3 = require('multer-s3')
const { uploadToB2 } = require('../../utils/b2Utils')

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
const AbtBanner          = require('../../models/abt/AbtBanner')
const AbtContactMessage  = require('../../models/abt/AbtContactMessage')
const AbtEgpItem         = require('../../models/abt/AbtEgpItem')
const AbtEgpPdfCache     = require('../../models/abt/AbtEgpPdfCache')
const AbtNotice          = require('../../models/abt/AbtNotice')

const upload = multer({ storage: multer.memoryStorage() })

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

const uploadExcel = multer({ storage: multer.memoryStorage() })

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
router.post('/upload', requireAuth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  try {
    const url = await uploadToB2(req.file.buffer, `abt-images/${Date.now()}-${req.file.originalname}`, req.file.mimetype)
    res.json({ url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
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

router.post('/upload-excel', requireAuth, uploadExcel.single('excel'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  try {
    const url = await uploadToB2(req.file.buffer, `abt-excel/${Date.now()}-${req.file.originalname}`, req.file.mimetype)
    res.json({ url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
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
    const item = await AbtNews.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/news/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtNews.findByIdAndDelete(req.params.id)
    if (!item) return res.status(404).json({ error: 'Not found' })
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
    const item = await AbtAnnouncement.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/announcements/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtAnnouncement.findByIdAndDelete(req.params.id)
    if (!item) return res.status(404).json({ error: 'Not found' })
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
    const item = await AbtProcurement.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/procurement/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtProcurement.findByIdAndDelete(req.params.id)
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// AI summarize — reads the fileUrl (PDF/HTML) and extracts project summary
router.post('/procurement/:id/summarize', requireAuth, async (req, res) => {
  try {
    const item = await AbtProcurement.findById(req.params.id)
    if (!item) return res.status(404).json({ error: 'Not found' })

    const url = item.fileUrl || item.externalUrl
    if (!url) return res.status(400).json({ error: 'ไม่มีลิงค์ไฟล์ กรุณาเพิ่มลิงค์ PDF หรือลิงค์ EGP ก่อน' })

    // Fetch the document
    let content = ''
    try {
      const axios = require('axios')
      const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AbtMaesai/1.0)' },
      })
      const ct = resp.headers['content-type'] || ''
      if (ct.includes('pdf')) {
        // Send PDF bytes to Claude as base64
        content = `[PDF document base64 omitted — ${resp.data.byteLength} bytes]`
        // For PDFs, extract text via Claude files API or just send title
      } else {
        // HTML: decode Thai encoding
        const decoded = new TextDecoder('windows-874').decode(resp.data)
        // Strip HTML tags and collapse whitespace
        content = decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 8000)
      }
    } catch (fetchErr) {
      content = `ชื่อโครงการ: ${item.title}`
    }

    const Anthropic = require('@anthropic-ai/sdk')
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `จากเอกสารประกาศจัดซื้อจัดจ้างต่อไปนี้ กรุณาสกัดข้อมูลและตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น:
{
  "title": "ชื่อโครงการ (string)",
  "winner": "ชื่อผู้ชนะการเสนอราคา (string หรือ null)",
  "amount": "ราคาที่เสนอหรือราคาสุทธิ เป็นตัวเลขบาท ไม่มีจุลภาค (number หรือ null)",
  "budget": "วงเงินงบประมาณหรือราคากลาง เป็นตัวเลขบาท (number หรือ null)",
  "method": "วิธีการจัดหา (string หรือ null)"
}

เนื้อหาเอกสาร:
${content}

ชื่อรายการปัจจุบัน: ${item.title}`,
      }],
    })

    let extracted = {}
    try {
      const text = message.content[0].text
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) extracted = JSON.parse(jsonMatch[0])
    } catch { extracted = {} }

    // Update the item with extracted fields (only non-null values)
    const update = {}
    if (extracted.title)  update.title  = extracted.title
    if (extracted.winner) update.winner = extracted.winner
    if (extracted.amount != null) update.amount = Number(extracted.amount)
    if (extracted.budget != null) update.budget = Number(extracted.budget)
    if (extracted.method) update.method = extracted.method

    const updated = await AbtProcurement.findByIdAndUpdate(req.params.id, update, { new: true })
    res.json({ extracted, item: updated })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── e-GP helpers ──────────────────────────────────────────────────────────────

function isMaintenanceText(str) {
  return /ไม่พร้อมให้บริการ|ปิดปรับปรุง|not available|maintenance/i.test(str || '')
}

function thaiToNum(str) {
  if (!str) return null
  const thai = '๐๑๒๓๔๕๖๗๘๙'
  const arabic = str.split('').map(c => { const i = thai.indexOf(c); return i >= 0 ? String(i) : c }).join('')
  const n = parseFloat(arabic.replace(/,/g, ''))
  return isNaN(n) ? null : n
}

async function enrichEgpItem(item) {
  if (!item.link || item.enriched) return null
  try {
    const { data: buf } = await require('axios').get(item.link, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AbtMaesai/1.0)' },
    })
    const text = new TextDecoder('windows-874').decode(buf)
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

    const titleM  = text.match(/ประกาศผู้ชนะการเสนอราคา\s+(.+?)\s+(?:นั้น|โดย|ตาม)/)
    const winnerM = text.match(/ผู้(?:ได้รับการคัดเลือก|ชนะการเสนอราคา)[^ก-๙]*ได้แก่\s+(.+?)\s+(?:โดยเสนอราคา|ซึ่งมี|งวด|เป็นเงิน)/)
    const amountM = text.match(/เป็นเงินทั้งสิ้น\s+([๐-๙\d,.]+)\s+บาท/)
    const methodM = text.match(/โดย(วิธี[ก-๙a-zA-Z\s\-]+?)(?=\s|$|[,\.])/)

    return {
      title:  titleM  ? titleM[1].trim()  : undefined,
      winner: winnerM ? winnerM[1].trim() : null,
      amount: amountM ? thaiToNum(amountM[1]) : null,
      method: methodM ? methodM[1].trim() : null,
      enriched: true,
    }
  } catch {
    return { enriched: true }  // mark done even on failure so we don't retry forever
  }
}

// CGD manual specifies process3 as the correct hostname for RSS
const EGP_RSS_URL = 'https://process3.gprocurement.go.th/EPROCRssFeedWeb/egpannouncerss.xml'

async function fetchEgpXml(params) {
  let lastErr
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data: buf } = await require('axios').get(EGP_RSS_URL,
        { params, timeout: 30000, maxRedirects: 5, responseType: 'arraybuffer',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AbtMaesai/1.0)' } }
      )
      return new TextDecoder('windows-874').decode(buf)
    } catch (err) {
      lastErr = err
      if (attempt === 0) await new Promise(r => setTimeout(r, 2000))
    }
  }
  throw lastErr
}

// Fetch live RSS and save new items to AbtEgpItem — runs in background after response
async function bgFetchEgp(anounceType) {
  const cheerio = require('cheerio')
  const deptSetting   = await AbtSettings.findOne({ key: 'egpDeptSubId' })
  const deptIdSetting = await AbtSettings.findOne({ key: 'egpDeptId' })
  const DEPT_SUB_ID   = deptSetting?.value  || '1509903843'
  const DEPT_ID       = deptIdSetting?.value || ''
  const metaKey       = `egp_meta_${anounceType}`
  const now           = new Date().toISOString()

  const params = {}
  if (DEPT_SUB_ID) params.deptsubId = DEPT_SUB_ID
  else if (DEPT_ID) params.deptId   = DEPT_ID
  if (anounceType) params.anounceType = anounceType

  try {
    const xml = await fetchEgpXml(params)
    const $ = cheerio.load(xml, { xmlMode: true })

    const channelTitle = $('channel > title').first().text()
    const channelDesc  = $('channel > description').first().text()
    const rssItems = []
    $('item').each((_, el) => {
      rssItems.push({
        title: $(el).find('title').text(),
        link:  $(el).find('link').text(),
        date:  $(el).find('pubDate').text(),
        desc:  $(el).find('description').text(),
      })
    })

    const allText = [channelTitle, channelDesc, ...rssItems.map(i => i.title)].join(' ')
    if (isMaintenanceText(allText) || (rssItems.length > 0 && rssItems.every(i => isMaintenanceText(i.title)))) {
      const notice = rssItems.map(i => i.title).filter(Boolean).join(' — ')
        || channelTitle || 'ระบบ e-GP ไม่พร้อมให้บริการในขณะนี้'
      await AbtSettings.findOneAndUpdate(
        { key: metaKey },
        { value: { maintenance: true, notice, checkedAt: now } },
        { upsert: true }
      )
      return
    }

    if (rssItems.length > 0) {
      // Upsert — $setOnInsert means existing enriched items are never overwritten
      await AbtEgpItem.bulkWrite(
        rssItems.map(item => ({
          updateOne: {
            filter: { link: item.link },
            update: { $setOnInsert: {
              anounceType,
              title: item.title,
              date:  item.date ? new Date(item.date) : null,
              desc:  item.desc,
              enriched: false,
            }},
            upsert: true,
          }
        })),
        { ordered: false }
      )
    }

    await AbtSettings.findOneAndUpdate(
      { key: metaKey },
      { value: { maintenance: false, lastFetchAt: now } },
      { upsert: true }
    )

    // Enrich up to 5 new items that don't have winner/amount yet
    const pending = await AbtEgpItem.find({ anounceType, enriched: false }).limit(5).lean()
    for (const item of pending) {
      const update = await enrichEgpItem(item)
      if (update) await AbtEgpItem.findByIdAndUpdate(item._id, update)
      if (pending.length > 1) await new Promise(r => setTimeout(r, 500))
    }
  } catch (err) {
    console.error('[egp-rss bgFetch] error:', err.message)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTICES (หัวข้อประกาศ)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/notices', async (req, res) => {
  try {
    const filter = req.query.all === '1' ? {} : { isActive: true }
    if (req.query.topic) filter.topic = req.query.topic
    const items = await AbtNotice.find(filter).sort({ publishedAt: -1 })
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/notices', requireAuth, async (req, res) => {
  try {
    const item = await AbtNotice.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/notices/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtNotice.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/notices/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtNotice.findByIdAndDelete(req.params.id)
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Seed known items that aren't in the RSS feed
;(async () => {
  try {
    const seeds = [
      {
        link: 'https://process.gprocurement.go.th/egp2procmainWeb/jsp/procsearch.sch?servlet=gojsp&proc_id=ShowHTMLFile&processFlows=Procure&projectId=69059483466&templateType=W2&temp_Announ=A&temp_itemNo=0&seqNo=1',
        anounceType: 'W0', title: 'ซื้ออาหารเสริมนม สำหรับเด็กนักเรียนของโรงเรียนชุมชนบ้านแม่ใส ภาคเรียนที่ ๑/๒๕๖๙ ประจำปีงบประมาณ ๒๕๖๙',
        winner: 'องค์การส่งเสริมกิจการโคนมแห่งประเทศไทย (อ.ส.ค.) (ผู้ผลิต)', amount: 111670, method: 'วิธีเฉพาะเจาะจง', date: new Date('2026-05-28'), enriched: true,
      },
      {
        link: 'https://process.gprocurement.go.th/egp2procmainWeb/jsp/procsearch.sch?servlet=gojsp&proc_id=ShowHTMLFile&processFlows=Procure&projectId=69059483666&templateType=W2&temp_Announ=A&temp_itemNo=0&seqNo=1',
        anounceType: 'W0', title: 'ซื้ออาหารเสริมนม สำหรับเด็กนักเรียนของศูนย์พัฒนาเด็กเล็ก อบต.แม่ใส ภาคเรียนที่ ๑/๒๕๖๙ ประจำปีงบประมาณ ๒๕๖๙',
        winner: 'องค์การส่งเสริมกิจการโคนมแห่งประเทศไทย (อ.ส.ค.) (ผู้ผลิต)', amount: 24567.40, method: 'วิธีเฉพาะเจาะจง', date: new Date('2026-05-28'), enriched: true,
      },
      {
        link: 'https://process.gprocurement.go.th/egp2procmainWeb/jsp/procsearch.sch?servlet=gojsp&proc_id=ShowHTMLFile&processFlows=Procure&projectId=69059217606&templateType=W2&temp_Announ=A&temp_itemNo=0&seqNo=1',
        anounceType: 'W0', title: 'จ้างซ่อมแซมฝายตำบลแม่ใส อำเภอเมืองพะเยา จังหวัดพะเยา',
        winner: 'ห้างหุ้นส่วนจำกัด อินทร์จันทร์ ก่อสร้าง (ให้บริการ)', amount: 163000, method: 'วิธีเฉพาะเจาะจง', date: new Date('2026-05-29'), enriched: true,
      },
      {
        link: 'https://process.gprocurement.go.th/egp2procmainWeb/jsp/procsearch.sch?servlet=gojsp&proc_id=ShowHTMLFile&processFlows=Procure&projectId=69059399173&templateType=W2&temp_Announ=A&temp_itemNo=0&seqNo=1',
        anounceType: 'W0', title: 'จ้างโครงการปรับปรุงรางระบายน้ำ แบบวางท่อระบายน้ำ ค.ส.ล. พร้อมบ่อพัก ค.ส.ล. ถนนสายปฏิบัติธรรม บ้านแม่ใสหัวขัว หมู่ที่ ๘ ตำบลแม่ใส',
        winner: 'บริษัท เวสสุวรรณ คอนสตรัคชั่น (1984) จำกัด (ขายส่ง,ขายปลีก,ให้บริการ)', amount: 485700, method: 'วิธีเฉพาะเจาะจง', date: new Date('2026-05-29'), enriched: true,
      },
      {
        link: 'https://process.gprocurement.go.th/egp2procmainWeb/jsp/procsearch.sch?servlet=gojsp&proc_id=ShowHTMLFile&processFlows=Procure&projectId=69059471444&templateType=W2&temp_Announ=D&temp_itemNo=1&seqNo=2',
        anounceType: 'W0', title: 'ยกเลิกประกาศผู้ได้รับการคัดเลือก จ้างโครงการกำจัดวัชพืชข้างคลองส่งน้ำ บ้านบ่อแฮ้ว หมู่ที่ ๕ ตำบลแม่ใส',
        method: 'วิธีเฉพาะเจาะจง', date: new Date('2026-05-28'), enriched: true,
      },
      {
        link: 'https://process.gprocurement.go.th/egp2procmainWeb/jsp/procsearch.sch?servlet=gojsp&proc_id=ShowHTMLFile&processFlows=Procure&projectId=69059471444&templateType=W2&temp_Announ=A&temp_itemNo=0&seqNo=3',
        anounceType: 'W0', title: 'จ้างโครงการกำจัดวัชพืชข้างคลองส่งน้ำ บ้านบ่อแฮ้ว หมู่ที่ ๕ ตำบลแม่ใส',
        winner: 'นายอุดม หลวงบุญมี', amount: 13300, method: 'วิธีเฉพาะเจาะจง', date: new Date('2026-05-28'), enriched: true,
      },
    ]
    for (const item of seeds) {
      await AbtEgpItem.updateOne(
        { link: item.link },
        { $setOnInsert: item },
        { upsert: true }
      )
    }
  } catch (e) {
    console.error('[egp seed]', e.message)
  }
})()

router.get('/egp-rss', async (req, res) => {
  const anounceType = req.query.anounceType || ''
  const metaKey     = `egp_meta_${anounceType}`

  // Serve from DB immediately, then refresh in background
  const [items, meta] = await Promise.all([
    AbtEgpItem.find({ anounceType }).sort({ date: -1 }).limit(100).lean(),
    AbtSettings.findOne({ key: metaKey }),
  ])

  const m = meta?.value || {}

  if (items.length === 0 && m.maintenance) {
    res.status(503).json({ maintenance: true, notice: m.notice, hours: '17:01–08:59 น.' })
  } else {
    res.json({
      items,
      fetchedAt: m.maintenance ? undefined : (m.lastFetchAt || null),
      stale:     m.maintenance && items.length > 0 ? true : undefined,
      staleAt:   m.maintenance && items.length > 0 ? m.checkedAt : undefined,
      notice:    m.maintenance ? m.notice : undefined,
    })
  }

  setImmediate(() => bgFetchEgp(anounceType).catch(() => {}))
})

// Extract agency name + budget from a bid PDF via plain regex — no AI involved.
// Government e-GP announcement PDFs follow a predictable opening template:
// "ประกาศ<agency>\nเรื่อง ..." and "...เป็นเงินทั้งสิ้น...<amount> บาท".
async function extractPdfInfo(link) {
  try {
    const { data: buf } = await require('axios').get(link, {
      responseType: 'arraybuffer', timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AbtMaesai/1.0)' },
    })
    const { PDFParse } = require('pdf-parse')
    const parser = new PDFParse({ data: buf })
    const { text } = await parser.getText()

    const agencyM = text.slice(0, 800).match(/ประกาศ([^\n]+?)\n+เรื่อง/)
    const budgetM = text.match(/เป็นเงินทั้งสิ้น[\s\S]{0,80}?([๐-๙\d][๐-๙\d,]*\.[๐-๙\d]{2})\s*บาท/)

    return {
      agency: agencyM ? agencyM[1].trim() : null,
      budget: budgetM ? thaiToNum(budgetM[1]) : null,
      enriched: true,
    }
  } catch {
    return { enriched: true }
  }
}

async function bgEnrichNational(links) {
  for (const link of links) {
    try {
      const exists = await AbtEgpPdfCache.findOne({ link }).lean()
      if (!exists) {
        const info = await extractPdfInfo(link)
        await AbtEgpPdfCache.findOneAndUpdate(
          { link },
          { $setOnInsert: { link, ...info } },
          { upsert: true }
        )
      }
    } catch { /* skip and continue */ }
    await new Promise((r) => setTimeout(r, 400))
  }
}

// Nationwide e-GP feed — live pass-through, no department filter.
// Kept separate from /egp-rss so it never touches the Maesai-scoped cache/cron.
// Agency/budget are enriched from each item's PDF in the background and cached
// in AbtEgpPdfCache (plain regex extraction, no AI).
router.get('/egp-rss-national', async (req, res) => {
  const anounceType = req.query.anounceType || 'D0'
  const cheerio = require('cheerio')

  try {
    const xml = await fetchEgpXml({ anounceType })
    const $ = cheerio.load(xml, { xmlMode: true })

    const channelTitle = $('channel > title').first().text()
    const channelDesc  = $('channel > description').first().text()
    const items = []
    $('item').each((_, el) => {
      items.push({
        title: $(el).find('title').text(),
        link:  $(el).find('link').text(),
        date:  $(el).find('pubDate').text() ? new Date($(el).find('pubDate').text()) : null,
        desc:  $(el).find('description').text(),
      })
    })

    const allText = [channelTitle, channelDesc, ...items.map(i => i.title)].join(' ')
    if (isMaintenanceText(allText) || (items.length > 0 && items.every(i => isMaintenanceText(i.title)))) {
      return res.status(503).json({
        maintenance: true,
        notice: items.map(i => i.title).filter(Boolean).join(' — ') || channelTitle || 'ระบบ e-GP ไม่พร้อมให้บริการในขณะนี้',
        hours: '17:01–08:59 น.',
      })
    }

    const trimmed = items.slice(0, 200)
    const links = trimmed.map((i) => i.link).filter(Boolean)
    const cached = await AbtEgpPdfCache.find({ link: { $in: links } }).lean()
    const cacheByLink = new Map(cached.map((c) => [c.link, c]))
    const withInfo = trimmed.map((item) => {
      const c = cacheByLink.get(item.link)
      return c ? { ...item, agency: c.agency, budget: c.budget } : item
    })

    res.json({ items: withInfo, fetchedAt: new Date().toISOString() })

    const uncachedLinks = links.filter((l) => !cacheByLink.has(l)).slice(0, 20)
    if (uncachedLinks.length) setImmediate(() => bgEnrichNational(uncachedLinks).catch(() => {}))
  } catch (err) {
    res.status(500).json({ error: err.message || 'ไม่สามารถเชื่อมต่อระบบ e-GP ได้' })
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
    const item = await AbtStaff.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/staff/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtStaff.findByIdAndDelete(req.params.id)
    if (!item) return res.status(404).json({ error: 'Not found' })
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
    const item = await AbtTravel.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/travel/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtTravel.findByIdAndDelete(req.params.id)
    if (!item) return res.status(404).json({ error: 'Not found' })
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
    const item = await AbtProduct.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/products/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtProduct.findByIdAndDelete(req.params.id)
    if (!item) return res.status(404).json({ error: 'Not found' })
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
    const item = await AbtProcurementPlan.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/procurement-plans/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtProcurementPlan.findByIdAndDelete(req.params.id)
    if (!item) return res.status(404).json({ error: 'Not found' })
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
    const item = await AbtOIT.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/oit/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtOIT.findByIdAndDelete(req.params.id)
    if (!item) return res.status(404).json({ error: 'Not found' })
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
    const item = await AbtEServiceType.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/eservice-types/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtEServiceType.findByIdAndDelete(req.params.id)
    if (!item) return res.status(404).json({ error: 'Not found' })
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
  const rand = String(crypto.randomInt(1000, 10000))
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
    const item = await AbtEService.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true })
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
    const item = await AbtComplaint.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true })
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
    const item = await AbtDocument.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/documents/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtDocument.findByIdAndDelete(req.params.id)
    if (!item) return res.status(404).json({ error: 'Not found' })
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
  { title: 'à¸šà¸£à¸´à¸à¸²à¸£à¸ªà¸²à¸˜à¸²à¸£à¸“à¸°',                    slug: 'builtin-public',      icon: 'ðŸŒ', path: '/public-service', isBuiltin: true, order: 6,  showInNavbar: false, isActive: false },
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
    const page = await AbtPage.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
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

function dateRanges() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')

  // week: Monday of this week
  const day = now.getDay() === 0 ? 6 : now.getDay() - 1
  const monday = new Date(now)
  monday.setDate(now.getDate() - day)
  const weekStart = monday.toISOString().slice(0, 10)

  const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
  const yearStart  = `${now.getFullYear()}-01-01`

  return { weekStart, monthStart, yearStart }
}

async function sumVisits(gte) {
  const agg = await AbtVisitor.aggregate([
    { $match: { date: { $gte: gte } } },
    { $group: { _id: null, total: { $sum: '$count' } } },
  ])
  return agg[0]?.total || 0
}

async function getStats(todayCount) {
  const { weekStart, monthStart, yearStart } = dateRanges()
  const [week, month, year, totalAgg] = await Promise.all([
    sumVisits(weekStart),
    sumVisits(monthStart),
    sumVisits(yearStart),
    AbtVisitor.aggregate([{ $group: { _id: null, total: { $sum: '$count' } } }]),
  ])
  return {
    today: todayCount,
    week,
    month,
    year,
    total: totalAgg[0]?.total || 0,
  }
}

router.get('/visits', async (req, res) => {
  try {
    const todayDoc = await AbtVisitor.findOne({ date: todayStr() })
    res.json(await getStats(todayDoc?.count || 0))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/visits', async (req, res) => {
  try {
    const doc = await AbtVisitor.findOneAndUpdate(
      { date: todayStr() },
      { $inc: { count: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    )
    res.json(await getStats(doc.count))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Banners ──────────────────────────────────────────────────────────────────
const DEFAULT_BANNERS = [
  { label: 'กรมส่งเสริมการปกครอง', sub: 'DLA',  href: 'http://www.dla.go.th/',          bg: 'linear-gradient(135deg,#1e3a8a,#2563eb)', order: 1 },
  { label: 'ระบบ E-GP',            sub: 'EGP',  href: 'http://www.gprocurement.go.th/', bg: 'linear-gradient(135deg,#065f46,#059669)', order: 2 },
  { label: 'ทะเบียนราษฎร',         sub: 'DOPA', href: 'https://stat.bora.dopa.go.th/',  bg: 'linear-gradient(135deg,#7c3aed,#a855f7)', order: 3 },
  { label: 'ระบบสวัสดิการ',         sub: 'WEL',  href: 'https://welfare.dla.go.th/',     bg: 'linear-gradient(135deg,#b45309,#f59e0b)', order: 4 },
  { label: 'เลือกตั้งท้องถิ่น',     sub: 'ELE',  href: 'https://ele.dla.go.th/',         bg: 'linear-gradient(135deg,#be123c,#f43f5e)', order: 5 },
  { label: 'เมล์กรมส่งเสริมฯ',      sub: 'MAIL', href: 'https://mail.dla.go.th/login',   bg: 'linear-gradient(135deg,#0e7490,#06b6d4)', order: 6 },
  { label: 'อุตุฯ เชียงใหม่',       sub: 'TMD',  href: 'https://cmmet.tmd.go.th/',       bg: 'linear-gradient(135deg,#0369a1,#38bdf8)', order: 7 },
  { label: 'LPA Dashboard',         sub: 'LPA',  href: '#',                               bg: 'linear-gradient(135deg,#4f46e5,#818cf8)', order: 8 },
  { label: 'แจ้งเบาะแสทุจริต',      sub: 'PACC', href: 'https://anonymous.pacc.go.th/', bg: 'linear-gradient(135deg,#7f1d1d,#dc2626)', order: 9 },
]

router.get('/banners', async (req, res) => {
  try {
    let items = await AbtBanner.find({ active: true }).sort({ order: 1, createdAt: 1 })
    if (items.length === 0) {
      items = await AbtBanner.insertMany(DEFAULT_BANNERS)
    }
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/banners/all', requireAuth, async (req, res) => {
  try {
    const items = await AbtBanner.find().sort({ order: 1, createdAt: 1 })
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/banners', requireAuth, async (req, res) => {
  try {
    const count = await AbtBanner.countDocuments()
    const item = await AbtBanner.create({ ...req.body, order: req.body.order ?? (count + 1) * 10 })
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/banners/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtBanner.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/banners/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtBanner.findByIdAndDelete(req.params.id)
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Facebook page info (followers) ──────────────────────────────────────────
let _fbCache = null
let _fbCacheAt = 0

router.get('/facebook-page', async (req, res) => {
  try {
    if (_fbCache && Date.now() - _fbCacheAt < 3_600_000) {
      return res.json({ data: _fbCache })
    }
    const appId     = process.env.FACEBOOK_APP_ID
    const appSecret = process.env.FACEBOOK_APP_SECRET
    if (!appId || !appSecret) return res.status(503).json({ error: 'Facebook credentials not configured' })

    const token = `${appId}|${appSecret}`
    const url   = `https://graph.facebook.com/v19.0/MaesaiSAOPhayao?fields=name,followers_count,fan_count&access_token=${token}`
    const resp  = await fetch(url)
    const data  = await resp.json()
    if (data.error) throw new Error(data.error.message)

    _fbCache   = data
    _fbCacheAt = Date.now()
    res.json({ data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// CONTACT MESSAGES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/contact-messages', requireAuth, async (req, res) => {
  try {
    const items = await AbtContactMessage.find().sort({ createdAt: -1 })
    res.json(items)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/contact-messages', requireAuth, async (req, res) => {
  try {
    const item = await AbtContactMessage.create(req.body)
    res.status(201).json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.put('/contact-messages/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtContactMessage.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/contact-messages/:id', requireAuth, async (req, res) => {
  try {
    const item = await AbtContactMessage.findByIdAndDelete(req.params.id)
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router


