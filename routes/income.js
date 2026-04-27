const express = require('express');
const router = express.Router();
const Income = require('../models/Income');

// GET all income (filter by month/year)
router.get('/', async (req, res) => {
  try {
    const { month, year } = req.query;
    let filter = {};
    if (month && year) {
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 1);
      filter.date = { $gte: start, $lt: end };
    }
    const income = await Income.find(filter).sort({ date: -1 });
    res.json(income);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add income
router.post('/', async (req, res) => {
  try {
    const income = new Income(req.body);
    await income.save();
    res.status(201).json(income);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE income
router.delete('/:id', async (req, res) => {
  try {
    await Income.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;