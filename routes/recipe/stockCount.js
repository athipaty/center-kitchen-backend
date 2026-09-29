const express = require("express");
const StockCount = require("../../models/recipe/StockCount");
const router = express.Router();

// GET all physical stock counts
router.get("/", async (req, res) => {
  try {
    const counts = await StockCount.find().sort({ name: 1 });
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST upsert a count by ingredient name (create or update)
router.post("/", async (req, res) => {
  try {
    const { name, qty, unit } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const count = await StockCount.findOneAndUpdate(
      { name },
      { name, qty, unit },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json(count);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
