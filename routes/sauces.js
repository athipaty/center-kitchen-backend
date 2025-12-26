// routes/sauces.js
const express = require("express");
const router = express.Router();
const Sauce = require("../models/Sauce");

/**
 * GET /sauces
 * - If outletId provided: return sauces for that outlet
 * - If no outletId: return ALL sauces (for Center Kitchen admin)
 */
router.get("/", async (req, res) => {
  try {
    const { outletId } = req.query;

    let filter = {};

    // Outlet-specific
    if (outletId && outletId !== "ALL") {
      filter.outletId = outletId;
    }

    const sauces = await Sauce.find(filter).populate("outletId", "name");

    res.json(sauces);
  } catch (err) {
    console.error("GET /sauces error:", err);
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /sauces
 * body: { outletId, sauceName, standardWeightKg }
 */
router.post("/", async (req, res) => {
  try {
    const { outletId, sauceName, standardWeightKg } = req.body;

    if (!outletId) return res.status(400).json({ message: "outletId is required" });
    if (!sauceName) return res.status(400).json({ message: "sauceName is required" });

    const sauce = new Sauce({
      outletId,
      sauceName: String(sauceName).trim(),
      standardWeightKg: Number(standardWeightKg || 0),
    });

    const created = await sauce.save();
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * PUT /sauces/:id
 * body: { outletId, sauceName, standardWeightKg }
 */
router.put("/:id", async (req, res) => {
  try {
    const { outletId, sauceName, standardWeightKg } = req.body;

    // outletId optional, but if you send it, it will update
    const update = {};
    if (outletId !== undefined) update.outletId = outletId;
    if (sauceName !== undefined) update.sauceName = String(sauceName).trim();
    if (standardWeightKg !== undefined) update.standardWeightKg = Number(standardWeightKg);

    const updated = await Sauce.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!updated) return res.status(404).json({ message: "Sauce not found" });

    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* ================================
   DELETE sauce (SAFE)
================================ */
router.delete("/:id", async (req, res) => {
  try {
    const sauce = await Sauce.findById(req.params.id);
    if (!sauce) {
      return res.status(404).json({ message: "Sauce not found" });
    }

    // 🔒 Check if sauce is used in any order
    const usedCount = await Order.countDocuments({
      sauce: sauce.sauceName,
      outletId: sauce.outletId,
    });

    if (usedCount > 0) {
      return res.status(409).json({
        message: "Cannot delete sauce. It is already used in existing orders.",
      });
    }

    await Sauce.findByIdAndDelete(req.params.id);
    res.json({ message: "Sauce deleted successfully" });
  } catch (err) {
    console.error("DELETE /sauces error:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
