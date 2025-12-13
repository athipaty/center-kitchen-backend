// routes/outlets.js
const express = require('express');
const router = express.Router();
const Outlet = require('../models/Outlet');

router.post('/', async (req, res) => {
  try {
    const outlet = new Outlet(req.body);
    await outlet.save();
    res.status(201).json(outlet);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get('/', async (req, res) => {
  const outlets = await Outlet.find();
  res.json(outlets);
});

module.exports = router;
