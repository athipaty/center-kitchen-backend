const express = require("express");
const router = express.Router();
const { checkItem } = require("../jobs/priceChecker");

// POST /api/monitor/:id
router.post("/:id", async (req, res) => {
  try {
    const result = await checkItem(req.params.id);
    res.json(result);
  } catch (err) {
    console.error("Monitor error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;