const express = require("express");
const LocationStockItem = require("../../models/recipe/LocationStockItem");
const router = express.Router();

// GET all location stock items (frontend groups/filters by location)
router.get("/", async (req, res) => {
  try {
    const items = await LocationStockItem.find().sort({ location: 1, name: 1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST upsert an item by location + name (add new item or update its qty)
router.post("/", async (req, res) => {
  try {
    const { location, name, unit, qty } = req.body;
    if (!location || !name) {
      return res.status(400).json({ error: "location and name are required" });
    }

    const item = await LocationStockItem.findOneAndUpdate(
      { location, name },
      { location, name, unit, qty },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json(item);
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
