// routes/outlets.js
const express = require('express');
const router = express.Router();
const Outlet = require('../models/Outlet');

// ✅ Get all outlets
router.get('/', async (req, res) => {
  try {
    const outlets = await Outlet.find();
    res.json(outlets);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ✅ Add a new outlet
router.post('/', async (req, res) => {
  const outlet = new Outlet(req.body);
  try {
    const newOutlet = await outlet.save();
    res.status(201).json(newOutlet);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ✅ Update an existing outlet
router.put('/:id', async (req, res) => {
  try {
    const updated = await Outlet.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ✅ Delete an outlet
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Outlet.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Outlet not found' });
    res.json({ message: 'Outlet deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
