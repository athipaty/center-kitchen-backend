const mongoose = require("mongoose");

const priceEntrySchema = new mongoose.Schema(
  {
    price: { type: Number, required: true },
  },
  { timestamps: true }
);

const productSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    currency: { type: String, default: "$" },
    current: { type: Number, required: true },
    lowest: { type: Number, required: true },
    history: [priceEntrySchema],
    nextCheck: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TrackedProduct", productSchema);
