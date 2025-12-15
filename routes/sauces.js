// routes/sauces.js
const express = require('express');
const router = express.Router();
const Sauce = require('../models/Sauce');

// ✅ Get all sauces
router.get('/', async (req, res) => {
  try {
    const sauces = await Sauce.find();
    res.json(sauces);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ✅ Add a new sauce
router.post('/', async (req, res) => {
  const sauce = new Sauce(req.body);
  try {
    const newSauce = await sauce.save();
    res.status(201).json(newSauce);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ✅ Update a sauce
router.put('/:id', async (req, res) => {
  try {
    const updated = await Sauce.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ✅ Delete a sauce
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Sauce.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Sauce not found' });
    res.json({ message: 'Sauce deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
