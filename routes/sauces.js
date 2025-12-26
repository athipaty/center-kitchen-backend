const express = require("express");
const router = express.Router();
const Sauce = require("../models/Sauce");

/**
 * GET sauces
 * - no outletId → ALL sauces (Center Kitchen)
 * - with outletId → outlet-specific
 */
router.get("/", async (req, res) => {
  try {
    const { outletId } = req.query;

    if (!outletId) {
      const sauces = await Sauce.find().sort({ sauceName: 1 });
      return res.json(sauces);
    }

    const sauces = await Sauce.find({ outletId }).sort({ sauceName: 1 });
    res.json(sauces);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* CREATE */
router.post("/", async (req, res) => {
  try {
    const sauce = new Sauce(req.body);
    res.status(201).json(await sauce.save());
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* UPDATE */
router.put("/:id", async (req, res) => {
  try {
    res.json(
      await Sauce.findByIdAndUpdate(req.params.id, req.body, { new: true })
    );
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* DELETE */
router.delete("/:id", async (req, res) => {
  try {
    await Sauce.findByIdAndDelete(req.params.id);
    res.json({ message: "Sauce deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
