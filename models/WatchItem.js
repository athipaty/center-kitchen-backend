const mongoose = require("mongoose");

const watchItemSchema = new mongoose.Schema({
  product: { type: String, required: true },
  amazonPrice: { type: Number, required: true },
  amazonUrl: { type: String },
  ebayCompetitorPrice: { type: Number },
  targetSellPrice: { type: Number, required: true },
  currency: { type: String, default: "USD" },
  status: {
    type: String,
    enum: ["active", "price_increased", "out_of_stock"],
    default: "active",
  },
  alerts: [{ type: String }],
  lastChecked: { type: Date, default: Date.now },
  addedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("WatchItem", watchItemSchema);