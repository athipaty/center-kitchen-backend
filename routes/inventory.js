const express = require("express");
const router = express.Router();
const Inventory = require("../models/Inventory");

/* ================================
   GET inventory (OUTLET SCOPED)
================================ */
router.get("/", async (req, res) => {
  try {
    const { outletId } = req.query;

    if (!outletId) {
      return res.status(400).json({ message: "outletId is required" });
    }

    const items = await Inventory.find({ outletId }).sort({
      createdAt: -1,
    });

    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ================================
   CREATE inventory item
================================ */
router.post("/", async (req, res) => {
  try {
    const { outletId, outletName, name, quantity, unit } = req.body;

    if (!outletId || !outletName || !name) {
      return res.status(400).json({
        message: "outletId, outletName and name are required",
      });
    }

    const item = new Inventory({
      outletId,
      outletName,
      name,
      quantity: Number(quantity) || 0,
      unit: unit || "kg",
    });

    const saved = await item.save();
    res.status(201).json(saved);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});


/* ================================
   UPDATE inventory item
================================ */
router.put("/:id", async (req, res) => {
  try {
    const { outletId, name, quantity, unit } = req.body;

    if (!outletId) {
      return res.status(400).json({
        message: "outletId is required",
      });
    }

    const item = await Inventory.findOne({
      _id: req.params.id,
      outletId,
    });

    if (!item) {
      return res.status(403).json({
        message: "Unauthorized or item not found",
      });
    }

    if (name !== undefined) item.name = name;
    if (quantity !== undefined) item.quantity = Number(quantity);
    if (unit !== undefined) item.unit = unit;

    const updated = await item.save();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


/* ================================
   DELETE inventory item
================================ */
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await Inventory.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ message: "Item not found" });
    }

    res.json({ message: "Inventory item deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
