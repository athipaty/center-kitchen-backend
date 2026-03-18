const express = require("express");
const router = express.Router();
const WatchItem = require("../models/WatchItem");
const PriceHistory = require("../models/PriceHistory");

// GET /api/watchlist
router.get("/", async (req, res) => {
  try {
    const items = await WatchItem.find().sort({ addedAt: -1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/watchlist
router.post("/", async (req, res) => {
  try {
    const item = new WatchItem({
      product: req.body.product,
      amazonPrice: req.body.amazon_price,
      amazonUrl: req.body.amazon_url,
      ebayCompetitorPrice: req.body.ebay_competitor_price,
      targetSellPrice: req.body.target_sell_price || req.body.ebay_competitor_price,
      currency: req.body.currency || "USD",
    });
    await item.save();

    await PriceHistory.create({
      watchItemId: item._id,
      amazonPrice: req.body.amazon_price,
      ebayCompetitorPrice: req.body.ebay_competitor_price,
    });

    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/watchlist/:id
router.delete("/:id", async (req, res) => {
  try {
    await WatchItem.findByIdAndDelete(req.params.id);
    await PriceHistory.deleteMany({ watchItemId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/watchlist/:id/history
router.get("/:id/history", async (req, res) => {
  try {
    const history = await PriceHistory.find({
      watchItemId: req.params.id,
    }).sort({ recordedAt: 1 });
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;