const express = require("express");
const LocationStockItem = require("../../models/recipe/LocationStockItem");
const router = express.Router();

// GET all location stock items (frontend groups/filters by location)
router.get("/", async (req, res) => {
  try {
    const items = await LocationStockItem.find().sort({ location: 1, order: 1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST upsert an item by location + name (add new item or update its qty).
// New items are appended to the end of that location's order.
router.post("/", async (req, res) => {
  try {
    const { location, name, unit, qty } = req.body;
    if (!location || !name) {
      return res.status(400).json({ error: "location and name are required" });
    }

    const existing = await LocationStockItem.findOne({ location, name });
    if (existing) {
      existing.unit = unit;
      existing.qty = qty;
      await existing.save();
      return res.json(existing);
    }

    const count = await LocationStockItem.countDocuments({ location });
    const item = await LocationStockItem.create({ location, name, unit, qty, order: count });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT reorder items within a location — body: { location, ids: [...] } in the new order
router.put("/reorder", async (req, res) => {
  try {
    const { location, ids } = req.body;
    if (!location || !Array.isArray(ids)) {
      return res.status(400).json({ error: "location and ids[] are required" });
    }

    await LocationStockItem.bulkWrite(
      ids.map((id, index) => ({
        updateOne: {
          filter: { _id: id, location },
          update: { $set: { order: index } },
        },
      }))
    );

    const items = await LocationStockItem.find({ location }).sort({ order: 1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE an item (e.g. added by mistake)
router.delete("/:id", async (req, res) => {
  try {
    const item = await LocationStockItem.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ error: "Item not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
