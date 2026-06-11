const express = require('express');
const router = express.Router();
const RawMaterial = require('../../models/accounting/RawMaterial');

router.get('/', async (req, res) => {
  try {
    const { company = 'Express', month, year } = req.query;
    const filter = { company };
    if (month) filter.month = parseInt(month);
    if (year) filter.year = parseInt(year);
    const materials = await RawMaterial.find(filter).sort({ code: 1 });
    res.json(materials);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = { ...req.body, company: req.body.company || 'Express' };
    body.balance = (body.openingBalance || 0) + (body.received || 0) - (body.issued || 0);
    body.totalValue = body.balance * (body.avgCost || body.latestCost || 0);
    const material = new RawMaterial(body);
    await material.save();
    res.status(201).json(material);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/bulk', async (req, res) => {
  try {
    const { items = [], company = 'Express', month, year } = req.body;
    const docs = items.map(m => {
      const bal = (m.openingBalance || 0) + (m.received || 0) - (m.issued || 0);
      return { ...m, company, month: parseInt(month), year: parseInt(year), balance: bal, totalValue: bal * (m.avgCost || m.latestCost || 0) };
    });
    const result = await RawMaterial.insertMany(docs, { ordered: false });
    res.status(201).json({ inserted: result.length });
  } catch (err) {
    res.status(400).json({ error: err.message, inserted: err.result?.nInserted || 0 });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const body = req.body;
    body.balance = (body.openingBalance || 0) + (body.received || 0) - (body.issued || 0);
    body.totalValue = body.balance * (body.avgCost || body.latestCost || 0);
    const material = await RawMaterial.findByIdAndUpdate(req.params.id, body, { new: true });
    res.json(material);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await RawMaterial.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
