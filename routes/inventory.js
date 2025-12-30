const express = require("express");
const router = express.Router();
const Inventory = require("../models/Inventory");

/* ================= GET ================= */
router.get("/", async (req, res) => {
  try {
    const { outletId } = req.query;
    if (!outletId) {
      return res.status(400).json({ message: "outletId is required" });
    }

    const items = await Inventory.find({ outletId }).sort({ createdAt: -1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ================= CREATE ================= */
router.post("/", async (req, res) => {
  try {
    const { outletId, outletName, name, quantity, unit } = req.body;

    if (!outletId || !outletName) {
      return res
        .status(400)
        .json({ message: "outletId and outletName are required" });
    }

    const item = new Inventory({
      outletId,
      outletName,
      name,
      quantity,
      unit,
    });

    const saved = await item.save();
    res.status(201).json(saved);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* ================= UPDATE ================= */
router.put("/:id", async (req, res) => {
  try {
    const { outletId } = req.body;
    if (!outletId) {
      return res.status(400).json({ message: "outletId required" });
    }

    const item = await Inventory.findOneAndUpdate(
      { _id: req.params.id, outletId },
      req.body,
      { new: true }
    );

    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }

    res.json(item);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ================= DELETE ================= */
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await Inventory.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Item not found" });
    }
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
