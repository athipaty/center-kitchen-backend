// routes/sauces.js
const express = require("express");
const router = express.Router();
const Sauce = require("../models/Sauce");

// ✅ Get sauces (filter by outletId)
router.get("/", async (req, res) => {
  try {
    const { outletId } = req.query;

    if (!outletId) {
      return res.status(400).json({
        message: "outletId is required",
      });
    }

    const sauces = await Sauce.find({ outletId });
    res.json(sauces);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
