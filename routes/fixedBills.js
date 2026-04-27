const express = require('express');
const router = express.Router();
const FixedBill = require('../models/FixedBill');

// GET bills for a specific month/year
router.get('/', async (req, res) => {
  try {
    const { month, year } = req.query;
    const filter = { isActive: true };
    if (month && year) {
      filter.month = Number(month);
      filter.year = Number(year);
    }
    const bills = await FixedBill.find(filter).sort({ order: 1 });
    res.json(bills);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create bill for a month
router.post('/', async (req, res) => {
  try {
    const bill = new FixedBill(req.body);
    await bill.save();
    res.status(201).json(bill);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT update bill
router.put('/:id', async (req, res) => {
  try {
    const bill = await FixedBill.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(bill);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE bill
router.delete('/:id', async (req, res) => {
  try {
    await FixedBill.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;