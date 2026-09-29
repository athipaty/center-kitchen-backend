const express = require("express");
const MonthlyStockItem = require("../../models/recipe/MonthlyStockItem");
const router = express.Router();

// GET all monthly stock items
router.get("/", async (req, res) => {
  try {
    const items = await MonthlyStockItem.find().sort({ supplier: 1, name: 1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST seed — only runs if collection is empty
router.post("/seed", async (req, res) => {
  try {
    const count = await MonthlyStockItem.countDocuments();
    if (count > 0) return res.json({ message: "Already seeded", count });

    const flat = req.body.flatMap((group) =>
      group.items.map((item) => ({
        supplier: group.supplier,
        name: item.name,
        unit: item.unit,
        qty: 0,
      }))
    );

    const inserted = await MonthlyStockItem.insertMany(flat);
    res.json({ message: "Seeded", count: inserted.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST upsert a single item's qty by supplier + name
router.post("/", async (req, res) => {
  try {
    const { supplier, name, unit, qty } = req.body;
    if (!supplier || !name) {
      return res.status(400).json({ error: "supplier and name are required" });
    }

    const item = await MonthlyStockItem.findOneAndUpdate(
      { supplier, name },
      { supplier, name, unit, qty },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
