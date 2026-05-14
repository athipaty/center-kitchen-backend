const express = require("express");
const InventoryFilter = require("../models/InventoryFilter");
const router = express.Router();

// GET the shared exclusion list
router.get("/", async (req, res) => {
  try {
    let doc = await InventoryFilter.findOne();
    if (!doc) doc = await InventoryFilter.create({ excluded: [] });
    res.json(doc.excluded);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT replace the exclusion list
router.put("/", async (req, res) => {
  try {
    let doc = await InventoryFilter.findOne();
    if (!doc) {
      doc = await InventoryFilter.create({ excluded: req.body.excluded || [] });
    } else {
      doc.excluded = req.body.excluded || [];
      await doc.save();
    }
    res.json(doc.excluded);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
