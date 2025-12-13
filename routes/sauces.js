// routes/sauces.js
const express = require('express');
const router = express.Router();
const Sauce = require('../models/Sauce');

router.post('/', async (req, res) => {
  try {
    const sauce = new Sauce(req.body);
    await sauce.save();
    res.status(201).json(sauce);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get('/', async (req, res) => {
  const sauces = await Sauce.find();
  res.json(sauces);
});

module.exports = router;
