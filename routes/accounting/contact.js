const express    = require('express');
const multer     = require('multer');
const router     = express.Router();
const ContactReport = require('../../models/accounting/ContactReport');
const { uploadToB2 } = require('../../utils/b2Utils');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
    const imageUrl = req.file
      ? await uploadToB2(req.file.buffer, `contact-images/${Date.now()}-${req.file.originalname}`, req.file.mimetype)
      : '';
    const report = await ContactReport.create({
      subject,
      description,
      imageUrl,
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
