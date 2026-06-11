const express    = require('express');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const router     = express.Router();
const ContactReport = require('../../models/accounting/ContactReport');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'pu_contact',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    transformation: [{ width: 1600, crop: 'limit' }],
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// GET all reports (newest first)
router.get('/', async (req, res) => {
  try {
    const reports = await ContactReport.find({ company: 'Express' }).sort({ createdAt: -1 });
    res.json(reports);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST submit a report (optional image)
router.post('/', upload.single('image'), async (req, res) => {
  try {
    const { subject, description, company } = req.body;
    if (!subject || !description) return res.status(400).json({ error: 'Subject and description required' });
    const report = await ContactReport.create({
      subject,
      description,
      imageUrl: req.file ? req.file.path : '',
      company:  company || 'Express',
    });
    res.status(201).json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH mark resolved
router.patch('/:id', async (req, res) => {
  try {
    const report = await ContactReport.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true },
    );
    res.json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
