// routes/sauces.js
const express = require("express");
const router = express.Router();
const Sauce = require("../models/Sauce");

// ✅ Create sauce
router.post("/", async (req, res) => {
  try {
    const sauce = new Sauce(req.body);
    const saved = await sauce.save();
    res.status(201).json(saved);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ✅ Update sauce
router.put("/:id", async (req, res) => {
  try {
    const updated = await Sauce.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});


module.exports = router;
