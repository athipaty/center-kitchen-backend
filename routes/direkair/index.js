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
// A job's pictures in display order; older jobs only have url (+ beforeUrl).
const imagesOf = (p) => (p.images?.length ? p.images : [
  { url: p.url, key: p.fileKey, kind: 'after' },
  ...(p.beforeUrl ? [{ url: p.beforeUrl, key: p.beforeKey, kind: 'before' }] : []),
]);
const toPublic = (p) => ({
  id: String(p._id), url: p.url, caption: p.caption, category: p.category || 'other',
  ...(p.beforeUrl ? { beforeUrl: p.beforeUrl } : {}),
  images: imagesOf(p).map(({ url, kind }) => ({ url, kind })),
});
const cleanCaption = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_CAPTION) : '');

const MAX_FILES_PER_UPLOAD = 10;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: MAX_FILES_PER_UPLOAD }, // the admin page sends big batches in parts
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

/* ---------- settings (theme colour) ---------- */

const field = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

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
  if (doc?.texts && (Object.keys(doc.texts.th || {}).length || Object.keys(doc.texts.en || {}).length)) {
    out.texts = { th: doc.texts.th || {}, en: doc.texts.en || {} };
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

/* ---------- page text ---------- */

// The admin edits text right on the home page; each editable element has a data-edit key.
// Text is stored as a small HTML fragment: only <b>, <strong>, <em>, <i> and <br> are kept,
// any other tag (and stray < or >) is removed, so saved text can't add links or scripts.
const TEXT_KEY = /^[a-z0-9-]{1,40}$/;
const MAX_TEXT = 2000;
const MAX_TEXT_KEYS = 300;
const SAFE_TAG = /<\/?(?:b|strong|em|i|br)\s*\/?>/gi;
function cleanText(v) {
  if (typeof v !== 'string') return '';
  const s = v.slice(0, MAX_TEXT);
  const strip = (t) => t.replace(/<[^<>]*>/g, '').replace(/[<>]/g, '');
  let out = '', last = 0;
  for (const m of s.matchAll(SAFE_TAG)) {
    out += strip(s.slice(last, m.index)) + m[0].toLowerCase().replace(/\s+/g, '');
    last = m.index + m[0].length;
  }
  return (out + strip(s.slice(last))).trim();
}

// Body: { lang: 'th' | 'en', texts: { key: text, otherKey: null } }; null (or empty) puts back the original text.
router.put('/texts', requireAdmin, async (req, res) => {
  const { lang, texts } = req.body || {};
  if (lang !== 'th' && lang !== 'en') return res.status(400).json({ error: 'ภาษาไม่ถูกต้อง' });
  if (!texts || typeof texts !== 'object' || Array.isArray(texts) || !Object.keys(texts).length) {
    return res.status(400).json({ error: 'ไม่มีข้อความที่จะบันทึก' });
  }
  try {
    const doc = await DirekairSetting.findOne({ key: 'site' }).lean();
    const current = { ...(doc?.texts?.[lang] || {}) };
    for (const [key, value] of Object.entries(texts)) {
      if (!TEXT_KEY.test(key)) return res.status(400).json({ error: 'รหัสข้อความไม่ถูกต้อง' });
      const text = value == null ? '' : cleanText(value);
      if (text && text.replace(/<[^>]*>/g, '').trim()) current[key] = text;
      else delete current[key];
    }
    if (Object.keys(current).length > MAX_TEXT_KEYS) return res.status(400).json({ error: 'แก้ข้อความได้ไม่เกิน ' + MAX_TEXT_KEYS + ' จุดต่อภาษา' });
    const saved = await DirekairSetting.findOneAndUpdate(
      { key: 'site' }, { $set: { ['texts.' + lang]: current } }, { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    res.json(publicSettings(saved));
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
  try {
    const rows = await DirekairStat.find({ day: { $gte: from, $lte: today } }).lean();
    const blank = () => ({ visit: 0, call: 0, line: 0, map: 0, visitEn: 0 });
    const byDay = {};
    for (let i = days - 1; i >= 0; i--) byDay[thaiDay(new Date(Date.now() - i * 86400_000))] = blank();
    for (const r of rows) {
      const d = byDay[r.day];
      if (!d || !(r.event in d)) continue; // e.g. old 'booking' counts from the removed booking form
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

const uploadErr = (err) => (err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกิน 10MB'
  : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `ส่งได้ครั้งละไม่เกิน ${MAX_FILES_PER_UPLOAD} รูป` : 'อัปโหลดไม่สำเร็จ');
const pictureFields = upload.fields([{ name: 'photo', maxCount: MAX_FILES_PER_UPLOAD }, { name: 'before', maxCount: MAX_FILES_PER_UPLOAD }]);

// Convert every uploaded file first (so a bad file stops the upload before anything is stored), then store them.
async function storePictures(files) {
  const list = [
    ...(files?.before || []).map((f) => ({ f, kind: 'before' })),
    ...(files?.photo || []).map((f) => ({ f, kind: 'after' })),
  ];
  const converted = [];
  for (const { f, kind } of list) {
    try { converted.push({ buf: await toWebp(f.buffer), kind }); }
    catch { const e = new Error('ไฟล์นี้ไม่ใช่รูปภาพที่รองรับ: ' + f.originalname); e.status = 400; throw e; }
  }
  const out = [];
  for (const { buf, kind } of converted) {
    const key = `${B2_PREFIX}${Date.now()}-${crypto.randomUUID()}${kind === 'before' ? '-before' : ''}.webp`;
    out.push({ url: await uploadToB2(buf, key, 'image/webp'), key, kind });
  }
  return out;
}
// Keep url/fileKey (cover = first 'after') and beforeUrl/beforeKey (first 'before') in step with images.
function setImages(photo, images) {
  const after = images.find((i) => i.kind === 'after');
  const before = images.find((i) => i.kind === 'before');
  photo.images = images;
  photo.url = after.url; photo.fileKey = after.key;
  photo.beforeUrl = before ? before.url : ''; photo.beforeKey = before ? before.key : '';
}
// The home page picture copies the cover's url, so follow a new cover.
const followCover = (photo) => DirekairSetting.updateOne(
  { key: 'site', heroPhotoId: String(photo._id) }, { $set: { heroUrl: photo.url } },
);
const plainImages = (p) => imagesOf(p).map(({ url, key, kind }) => ({ url, key, kind }));

// New job: one or more 'photo' (after) pictures, plus any number of 'before' pictures.
router.post('/gallery', requireAdmin, (req, res) => {
  pictureFields(req, res, async (err) => {
    if (err) return res.status(400).json({ error: uploadErr(err) });
    if (!req.files?.photo?.length) return res.status(400).json({ error: 'กรุณาเลือกรูปหลังทำอย่างน้อย 1 รูป (JPG, PNG หรือ WebP)' });
    if (!b2Enabled()) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่าที่เก็บรูป (B2)' });
    const category = PHOTO_CATEGORIES.includes(req.body.category) ? req.body.category : 'other';
    try {
      const images = await storePictures(req.files);
      const first = await DirekairPhoto.findOne().sort({ order: 1 }).lean();
      const photo = new DirekairPhoto({ category, caption: cleanCaption(req.body.caption), order: first ? first.order - 1 : 0 });
      setImages(photo, images);
      await photo.save();
      res.status(201).json(toPublic(photo));
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error('direkair: upload failed:', e.message);
      res.status(500).json({ error: 'บันทึกรูปไม่สำเร็จ' });
    }
  });
});

// Add more pictures ('photo' = after, 'before') to a job; they go to the end of their kind.
router.post('/gallery/:id/images', requireAdmin, (req, res) => {
  pictureFields(req, res, async (err) => {
    if (err) return res.status(400).json({ error: uploadErr(err) });
    if (!req.files?.photo?.length && !req.files?.before?.length) return res.status(400).json({ error: 'กรุณาเลือกรูป JPG, PNG หรือ WebP' });
    if (!b2Enabled()) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่าที่เก็บรูป (B2)' });
    try {
      const photo = await DirekairPhoto.findById(req.params.id);
      if (!photo) return res.status(404).json({ error: 'ไม่พบงานนี้' });
      const added = await storePictures(req.files);
      // fetch again: another batch may have been added while these were uploading
      const fresh = await DirekairPhoto.findById(req.params.id);
      if (!fresh) { for (const i of added) await deleteB2File(i.key); return res.status(404).json({ error: 'ไม่พบงานนี้' }); }
      setImages(fresh, [...plainImages(fresh), ...added]);
      await fresh.save();
      res.json(toPublic(fresh));
    } catch (e) {
      if (e.name === 'CastError') return res.status(404).json({ error: 'ไม่พบงานนี้' });
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error('direkair: add pictures failed:', e.message);
      res.status(500).json({ error: 'บันทึกรูปไม่สำเร็จ' });
    }
  });
});

// Remove one picture (by url). A job keeps at least one 'after' picture; delete the job instead.
router.delete('/gallery/:id/images', requireAdmin, async (req, res) => {
  try {
    const photo = await DirekairPhoto.findById(req.params.id);
    if (!photo) return res.status(404).json({ error: 'ไม่พบงานนี้' });
    const images = plainImages(photo);
    const gone = images.find((i) => i.url === req.body?.url);
    if (!gone) return res.status(404).json({ error: 'ไม่พบรูปนี้ กรุณารีเฟรชหน้า' });
    const rest = images.filter((i) => i !== gone);
    if (!rest.some((i) => i.kind === 'after')) {
      return res.status(400).json({ error: 'งานต้องมีรูปหลังทำอย่างน้อย 1 รูป ถ้าจะลบทั้งงาน กด "ลบงาน"' });
    }
    setImages(photo, rest);
    await photo.save();
    await deleteB2File(gone.key);
    await followCover(photo);
    res.json(toPublic(photo));
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ error: 'ไม่พบงานนี้' });
    res.status(500).json({ error: err.message });
  }
});

// New picture order (all urls of the job). The first 'after' one becomes the cover.
router.put('/gallery/:id/images/order', requireAdmin, async (req, res) => {
  try {
    const photo = await DirekairPhoto.findById(req.params.id);
    if (!photo) return res.status(404).json({ error: 'ไม่พบงานนี้' });
    const images = plainImages(photo);
    const urls = req.body?.urls;
    const byUrl = new Map(images.map((i) => [i.url, i]));
    if (!Array.isArray(urls) || urls.length !== images.length || new Set(urls).size !== urls.length || !urls.every((u) => byUrl.has(u))) {
      return res.status(400).json({ error: 'ลำดับรูปไม่ถูกต้อง กรุณารีเฟรชหน้า' });
    }
    setImages(photo, urls.map((u) => byUrl.get(u)));
    await photo.save();
    await followCover(photo);
    res.json(toPublic(photo));
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ error: 'ไม่พบงานนี้' });
    res.status(500).json({ error: err.message });
  }
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
    for (const i of imagesOf(photo)) await deleteB2File(i.key);
    // stop using it as the home page picture
    await DirekairSetting.updateOne({ key: 'site', heroPhotoId: String(photo._id) }, { $set: { heroPhotoId: '', heroUrl: '' } });
    res.json({ ok: true });
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ error: 'ไม่พบรูปนี้' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
