const express   = require('express');
const crypto    = require('crypto');
const jwt       = require('jsonwebtoken');
const multer    = require('multer');
const sharp     = require('sharp');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const { uploadToB2, deleteB2File, b2Enabled } = require('../../utils/b2Utils');
const DirekairPhoto = require('../../models/direkair/DirekairPhoto');
const DirekairSetting = require('../../models/direkair/DirekairSetting');
const DirekairBooking = require('../../models/direkair/DirekairBooking');
const DirekairStat = require('../../models/direkair/DirekairStat');

// Direk Air (ดิเรกแอร์) shop site: admin login + customer-work photo gallery.
//
// Deliberately NOT using the shared Token collection (routes/shared/auth.js): those tokens
// aren't scoped to a project, so any of them would also pass every other project's
// Token-based requireAuth. Direk Air gets its own password and JWT secret, with no defaults —
// login is disabled until both are set.
//   DIREKAIR_ADMIN_PASSWORD  shop admin password
//   DIREKAIR_JWT_SECRET      signs admin tokens (long random string)

const TOKEN_AUDIENCE = 'direkair';
const MAX_PHOTOS     = 60;
const MAX_CAPTION    = 120;
const B2_PREFIX      = 'direkair-gallery/';
const THEME_ID       = /^[a-z][a-z0-9-]{1,23}$/; // the site owns the theme list; this only rejects junk

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'ใส่รหัสผิดหลายครั้งเกินไป กรุณารอ 15 นาที' },
});

const configured = () => !!(process.env.DIREKAIR_ADMIN_PASSWORD && process.env.DIREKAIR_JWT_SECRET);

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireAdmin(req, res, next) {
  if (!configured()) return res.status(503).json({ error: 'Direk Air admin is not configured' });
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  try {
    jwt.verify(header.slice(7), process.env.DIREKAIR_JWT_SECRET, { audience: TOKEN_AUDIENCE });
    next();
  } catch {
    res.status(401).json({ error: 'กรุณาเข้าสู่ระบบใหม่' });
  }
}

const PHOTO_CATEGORIES = ['aircon', 'carryboy', 'tint', 'audio', 'other'];
const toPublic = (p) => ({
  id: String(p._id), url: p.url, caption: p.caption, category: p.category || 'other',
  ...(p.beforeUrl ? { beforeUrl: p.beforeUrl } : {}),
});
const cleanCaption = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_CAPTION) : '');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 2 }, // the photo, plus an optional "before" photo
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)),
});

/* ---------- auth ---------- */

router.post('/login', loginLimiter, (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'ยังไม่ได้ตั้งรหัสผ่านแอดมิน' });
  if (!safeEqual(req.body?.password ?? '', process.env.DIREKAIR_ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  }
  const token = jwt.sign({ role: 'admin' }, process.env.DIREKAIR_JWT_SECRET, { audience: TOKEN_AUDIENCE, expiresIn: '7d' });
  res.json({ token });
});

router.get('/me', requireAdmin, (_req, res) => res.json({ admin: true }));

/* ---------- bookings ---------- */

// Public booking form: cap per IP so the endpoint can't be used to flood the inbox.
const bookingLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'ส่งการจองหลายครั้งเกินไป กรุณาโทรหาร้าน' },
});
const BOOKING_STATUSES = ['new', 'confirmed', 'done', 'cancelled'];
const MAX_BOOKINGS = 2000;
const field = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const toBooking = (b) => ({
  id: String(b._id), name: b.name, phone: b.phone, car: b.car, service: b.service,
  date: b.date, note: b.note, lang: b.lang, status: b.status, createdAt: b.createdAt,
});

router.post('/bookings', bookingLimiter, async (req, res) => {
  const body = req.body || {};
  // Hidden "website" field: people never see it, form-filling bots usually do. Pretend success.
  if (field(body.website, 200)) return res.status(201).json({ ok: true });
  const name = field(body.name, 80);
  const phone = field(body.phone, 30);
  if (!name || !/^[0-9+\-\s()]{6,30}$/.test(phone)) {
    return res.status(400).json({ error: 'กรุณากรอกชื่อและเบอร์โทรให้ถูกต้อง' });
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : '';
  try {
    if (await DirekairBooking.estimatedDocumentCount() >= MAX_BOOKINGS) {
      return res.status(503).json({ error: 'ระบบจองเต็ม กรุณาติดต่อร้านทาง LINE หรือโทร' });
    }
    const b = await DirekairBooking.create({
      name, phone, date,
      car: field(body.car, 80),
      service: field(body.service, 120),
      note: field(body.note, 500),
      lang: body.lang === 'en' ? 'en' : 'th',
    });
    bump('booking', b.lang).catch(() => {});
    res.status(201).json({ ok: true, id: String(b._id) });
  } catch (err) {
    console.error('direkair: booking failed:', err.message);
    res.status(500).json({ error: 'บันทึกการจองไม่สำเร็จ' });
  }
});

router.get('/bookings', requireAdmin, async (req, res) => {
  try {
    const filter = BOOKING_STATUSES.includes(req.query.status) ? { status: req.query.status } : {};
    const [items, counts] = await Promise.all([
      DirekairBooking.find(filter).sort({ createdAt: -1 }).limit(300).lean(),
      DirekairBooking.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    res.json({
      bookings: items.map(toBooking),
      counts: Object.fromEntries(BOOKING_STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.n || 0])),
      retentionDays: DirekairBooking.RETENTION_DAYS,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/bookings/:id', requireAdmin, async (req, res) => {
  const status = req.body?.status;
  if (!BOOKING_STATUSES.includes(status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  try {
    const b = await DirekairBooking.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!b) return res.status(404).json({ error: 'ไม่พบการจองนี้' });
    res.json(toBooking(b));
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ error: 'ไม่พบการจองนี้' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/bookings/:id', requireAdmin, async (req, res) => {
  try {
    const b = await DirekairBooking.findByIdAndDelete(req.params.id);
    if (!b) return res.status(404).json({ error: 'ไม่พบการจองนี้' });
    res.json({ ok: true });
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ error: 'ไม่พบการจองนี้' });
    res.status(500).json({ error: err.message });
  }
});

/* ---------- settings (theme colour) ---------- */

const PHONE_RE = /^[0-9+\-\s()]{6,30}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const publicSettings = (doc) => {
  const out = { theme: doc?.theme || 'ice' };
  if (doc?.phones?.length) out.phones = doc.phones.map((p) => ({ number: p.number, type: p.type }));
  if (doc?.hours && (doc.hours.th || doc.hours.en)) out.hours = { th: doc.hours.th || '', en: doc.hours.en || '' };
  if (doc?.heroUrl) out.heroPhoto = { id: doc.heroPhotoId, url: doc.heroUrl };
  if (doc?.announcement) {
    const a = doc.announcement;
    out.announcement = { enabled: !!a.enabled, th: a.th || '', en: a.en || '', until: a.until || '' };
  }
  return out;
};

router.get('/settings', async (_req, res) => {
  try {
    const doc = await DirekairSetting.findOne({ key: 'site' }).lean();
    res.set('Cache-Control', 'no-cache');
    res.json(publicSettings(doc));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Partial update: only the fields present in the body are validated and saved.
router.put('/settings', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const update = {};
  if ('theme' in body) {
    if (typeof body.theme !== 'string' || !THEME_ID.test(body.theme)) return res.status(400).json({ error: 'ธีมไม่ถูกต้อง' });
    update.theme = body.theme;
  }
  if ('phones' in body) {
    const list = Array.isArray(body.phones) ? body.phones : null;
    if (!list || list.length < 1 || list.length > 4) return res.status(400).json({ error: 'ใส่เบอร์โทร 1–4 เบอร์' });
    const phones = [];
    for (const p of list) {
      const number = field(p?.number, 30);
      if (!PHONE_RE.test(number)) return res.status(400).json({ error: `เบอร์โทรไม่ถูกต้อง: ${number || '(ว่าง)'}` });
      phones.push({ number, type: p?.type === 'mobile' ? 'mobile' : 'shop' });
    }
    update.phones = phones;
  }
  if ('hours' in body) {
    const th = field(body.hours?.th, 120), en = field(body.hours?.en, 120);
    if (!th) return res.status(400).json({ error: 'กรุณาใส่เวลาทำการภาษาไทย' });
    update.hours = { th, en };
  }
  if ('announcement' in body) {
    const a = body.announcement || {};
    const until = typeof a.until === 'string' && DATE_RE.test(a.until) ? a.until : '';
    const th = field(a.th, 200), en = field(a.en, 200);
    if (a.enabled && !th) return res.status(400).json({ error: 'กรุณาใส่ข้อความประกาศภาษาไทย' });
    update.announcement = { enabled: !!a.enabled, th, en, until };
  }
  if ('heroPhotoId' in body) {
    if (!body.heroPhotoId) { update.heroPhotoId = ''; update.heroUrl = ''; }
    else {
      const photo = await DirekairPhoto.findById(String(body.heroPhotoId)).lean().catch(() => null);
      if (!photo) return res.status(400).json({ error: 'ไม่พบรูปนี้' });
      update.heroPhotoId = String(photo._id); update.heroUrl = photo.url;
    }
  }
  if (!Object.keys(update).length) return res.status(400).json({ error: 'ไม่มีข้อมูลที่จะบันทึก' });
  try {
    const doc = await DirekairSetting.findOneAndUpdate(
      { key: 'site' }, { $set: update }, { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    res.json(publicSettings(doc));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- stats (counts only) ---------- */

const thaiDay = (d = new Date()) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse/i;
const TRACK_EVENTS = ['visit', 'call', 'line', 'map'];
const trackLimiter = rateLimit({ windowMs: 60 * 60_000, max: 300, standardHeaders: true, legacyHeaders: false });

function bump(event, lang) {
  return DirekairStat.updateOne(
    { day: thaiDay(), event, lang: lang === 'en' ? 'en' : 'th' }, { $inc: { n: 1 } }, { upsert: true },
  );
}

// Called by the site with navigator.sendBeacon (text/plain body, so no CORS preflight) or fetch (JSON).
router.post('/track', express.text({ type: 'text/plain', limit: '1kb' }), trackLimiter, async (req, res) => {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const event = body?.event;
  if (!TRACK_EVENTS.includes(event)) return res.status(400).end();
  if (BOT_UA.test(req.headers['user-agent'] || '')) return res.status(204).end();
  try { await bump(event, body.lang); } catch (err) { console.error('direkair: track failed:', err.message); }
  res.status(204).end();
});

router.get('/stats', requireAdmin, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 90);
  const today = thaiDay();
  const from = thaiDay(new Date(Date.now() - (days - 1) * 86400_000));
  const monthFrom = thaiDay(new Date(Date.now() - 365 * 86400_000)).slice(0, 7) + '-01';
  try {
    const [rows, months] = await Promise.all([
      DirekairStat.find({ day: { $gte: from, $lte: today } }).lean(),
      DirekairStat.aggregate([
        { $match: { event: 'booking', day: { $gte: monthFrom } } },
        { $group: { _id: { $substrCP: ['$day', 0, 7] }, n: { $sum: '$n' } } },
        { $sort: { _id: 1 } },
      ]),
    ]);
    const blank = () => ({ visit: 0, call: 0, line: 0, map: 0, booking: 0, visitEn: 0 });
    const byDay = {};
    for (let i = days - 1; i >= 0; i--) byDay[thaiDay(new Date(Date.now() - i * 86400_000))] = blank();
    for (const r of rows) {
      const d = byDay[r.day]; if (!d) continue;
      d[r.event] += r.n;
      if (r.event === 'visit' && r.lang === 'en') d.visitEn += r.n;
    }
    const series = Object.entries(byDay).map(([day, v]) => ({ day, ...v }));
    const sum = (list) => list.reduce((t, d) => { for (const k of Object.keys(t)) t[k] += d[k]; return t; }, blank());
    res.json({
      today,
      days: series,
      last7: sum(series.slice(-7)),
      lastN: sum(series),
      bookingsByMonth: months.map((m) => ({ month: m._id, n: m.n })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- gallery ---------- */

router.get('/gallery', async (_req, res) => {
  try {
    const photos = await DirekairPhoto.find().sort({ order: 1, createdAt: -1 }).lean();
    res.set('Cache-Control', 'no-cache');
    res.json(photos.map(toPublic));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resize, convert to WebP, and drop EXIF (customer photos can carry GPS of their home).
const toWebp = (buf) => sharp(buf)
  .rotate()
  .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
  .webp({ quality: 82 })
  .toBuffer();

router.post('/gallery', requireAdmin, (req, res) => {
  upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'before', maxCount: 1 }])(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกิน 10MB' : 'อัปโหลดไม่สำเร็จ' });
    }
    const main = req.files?.photo?.[0];
    const before = req.files?.before?.[0];
    if (!main) return res.status(400).json({ error: 'กรุณาเลือกรูป JPG, PNG หรือ WebP' });
    if (!b2Enabled()) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่าที่เก็บรูป (B2)' });
    const category = PHOTO_CATEGORIES.includes(req.body.category) ? req.body.category : 'other';

    try {
      if (await DirekairPhoto.countDocuments() >= MAX_PHOTOS) {
        return res.status(400).json({ error: `มีรูปครบ ${MAX_PHOTOS} รูปแล้ว กรุณาลบรูปเก่าก่อน` });
      }

      let image, beforeImage;
      try {
        image = await toWebp(main.buffer);
        if (before) beforeImage = await toWebp(before.buffer);
      } catch {
        return res.status(400).json({ error: 'ไฟล์นี้ไม่ใช่รูปภาพที่รองรับ' });
      }

      const stamp = `${Date.now()}-${crypto.randomUUID()}`;
      const fileKey = `${B2_PREFIX}${stamp}.webp`;
      const url = await uploadToB2(image, fileKey, 'image/webp');
      let beforeKey = '', beforeUrl = '';
      if (beforeImage) {
        beforeKey = `${B2_PREFIX}${stamp}-before.webp`;
        beforeUrl = await uploadToB2(beforeImage, beforeKey, 'image/webp');
      }
      const first = await DirekairPhoto.findOne().sort({ order: 1 }).lean();
      const photo = await DirekairPhoto.create({
        url, fileKey, beforeUrl, beforeKey, category,
        caption: cleanCaption(req.body.caption), order: first ? first.order - 1 : 0,
      });
      res.status(201).json(toPublic(photo));
    } catch (e) {
      console.error('direkair: upload failed:', e.message);
      res.status(500).json({ error: 'บันทึกรูปไม่สำเร็จ' });
    }
  });
});

// Registered before '/gallery/:id' so 'order' isn't taken as an id.
router.put('/gallery/order', requireAdmin, async (req, res) => {
  try {
    const ids = req.body?.ids;
    const existing = await DirekairPhoto.find().select('_id').lean();
    const known = new Set(existing.map((p) => String(p._id)));
    if (!Array.isArray(ids) || ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
      return res.status(400).json({ error: 'ลำดับรูปไม่ถูกต้อง กรุณารีเฟรชหน้า' });
    }
    await DirekairPhoto.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { order: i } } })));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/gallery/:id', requireAdmin, async (req, res) => {
  try {
    const update = {};
    if (typeof req.body?.caption === 'string') update.caption = cleanCaption(req.body.caption);
    if ('category' in (req.body || {})) {
      if (!PHOTO_CATEGORIES.includes(req.body.category)) return res.status(400).json({ error: 'ประเภทไม่ถูกต้อง' });
      update.category = req.body.category;
    }
    if (!Object.keys(update).length) return res.status(400).json({ error: 'ไม่มีข้อมูลที่จะบันทึก' });
    const photo = await DirekairPhoto.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!photo) return res.status(404).json({ error: 'ไม่พบรูปนี้' });
    res.json(toPublic(photo));
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ error: 'ไม่พบรูปนี้' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/gallery/:id', requireAdmin, async (req, res) => {
  try {
    const photo = await DirekairPhoto.findByIdAndDelete(req.params.id);
    if (!photo) return res.status(404).json({ error: 'ไม่พบรูปนี้' });
    await deleteB2File(photo.fileKey);
    if (photo.beforeKey) await deleteB2File(photo.beforeKey);
    // stop using it as the home page picture
    await DirekairSetting.updateOne({ key: 'site', heroPhotoId: String(photo._id) }, { $set: { heroPhotoId: '', heroUrl: '' } });
    res.json({ ok: true });
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ error: 'ไม่พบรูปนี้' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
