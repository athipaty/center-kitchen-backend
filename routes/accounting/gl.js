const express = require('express');
const router = express.Router();
const GlEntry = require('../../models/accounting/GlEntry');

// GET list with filters + pagination
router.get('/', async (req, res) => {
  try {
    const { company = 'Express', code, month, year, journal, voucher, search, page = 1, limit = 100 } = req.query;
    const filter = { company };
    if (code) filter.code = code;
    if (journal) filter.journal = journal;
    if (voucher) filter.voucher = { $regex: voucher, $options: 'i' };
    if (search) filter.$or = [
      { description: { $regex: search, $options: 'i' } },
      { voucher: { $regex: search, $options: 'i' } },
    ];
    if (month && year) {
      filter.date = { $gte: new Date(year, month - 1, 1), $lt: new Date(year, month, 1) };
    } else if (year) {
      filter.date = { $gte: new Date(year, 0, 1), $lt: new Date(parseInt(year) + 1, 0, 1) };
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [entries, total] = await Promise.all([
      GlEntry.find(filter).sort({ date: 1, voucher: 1, code: 1 }).skip(skip).limit(parseInt(limit)),
      GlEntry.countDocuments(filter),
    ]);
    res.json({ entries, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET account-level summary for a period
router.get('/summary', async (req, res) => {
  try {
    const { company = 'Express', month, year } = req.query;
    const filter = { company };
    if (month && year) {
      filter.date = { $gte: new Date(year, month - 1, 1), $lt: new Date(year, month, 1) };
    } else if (year) {
      filter.date = { $gte: new Date(year, 0, 1), $lt: new Date(parseInt(year) + 1, 0, 1) };
    }
    const summary = await GlEntry.aggregate([
      { $match: filter },
      {
        $group: {
          _id: { code: '$code', account: '$account' },
          totalDebit:  { $sum: '$debit' },
          totalCredit: { $sum: '$credit' },
          count:       { $sum: 1 },
        },
      },
      { $sort: { '_id.code': 1 } },
    ]);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET monthly aggregation for charts
router.get('/monthly', async (req, res) => {
  try {
    const { company = 'Express', year } = req.query;
    const y = parseInt(year) || new Date().getFullYear();
    const summary = await GlEntry.aggregate([
      { $match: { company, date: { $gte: new Date(y, 0, 1), $lt: new Date(y + 1, 0, 1) } } },
      {
        $group: {
          _id: {
            month: { $month: '$date' },
            codePrefix: { $substr: ['$code', 0, 1] },
          },
          totalDebit:  { $sum: '$debit' },
          totalCredit: { $sum: '$credit' },
        },
      },
      { $sort: { '_id.month': 1 } },
    ]);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create single entry
router.post('/', async (req, res) => {
  try {
    const entry = new GlEntry({ ...req.body, company: req.body.company || 'Express' });
    await entry.save();
    res.status(201).json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST bulk import
router.post('/import', async (req, res) => {
  try {
    const { entries = [], company = 'Express' } = req.body;
    const docs = entries.map(e => ({ ...e, company }));
    const result = await GlEntry.insertMany(docs, { ordered: false });
    res.status(201).json({ inserted: result.length });
  } catch (err) {
    res.status(400).json({ error: err.message, inserted: err.result?.nInserted || 0 });
  }
});

// PUT update
router.put('/:id', async (req, res) => {
  try {
    const entry = await GlEntry.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE
router.delete('/:id', async (req, res) => {
  try {
    await GlEntry.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE all for a company (dangerous — needs confirmation header)
router.delete('/all/:company', async (req, res) => {
  try {
    if (req.headers['x-confirm'] !== 'yes') return res.status(400).json({ error: 'Missing confirmation header' });
    const result = await GlEntry.deleteMany({ company: req.params.company });
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
