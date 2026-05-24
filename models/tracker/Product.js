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
    image: { type: String, default: null },
    images: { type: [String], default: [] },
    upc: { type: String, default: null },
    currency: { type: String, default: "$" },
    current: { type: Number, required: true },
    lowest: { type: Number, required: true },
    history: [priceEntrySchema],
    nextCheck: { type: Date, default: () => new Date() },
    isPrime: { type: Boolean, default: false },
    variant: { type: String, default: null },
    groupId: { type: String, default: null, index: true },
    specs: { type: mongoose.Schema.Types.Mixed, default: {} },
    ebayListingId: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TrackedProduct", productSchema);
