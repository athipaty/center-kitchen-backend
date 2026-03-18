const mongoose = require("mongoose");

const priceHistorySchema = new mongoose.Schema({
  watchItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "WatchItem",
    required: true,
  },
  amazonPrice: { type: Number, required: true },
  ebayCompetitorPrice: { type: Number },
  recordedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("PriceHistory", priceHistorySchema);