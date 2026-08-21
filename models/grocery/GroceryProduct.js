const mongoose = require("mongoose");

const priceEntrySchema = new mongoose.Schema(
  { price: { type: Number, required: true } },
  { timestamps: true }
);

// One tracked listing at one supermarket. Several products with the same
// `category` (e.g. "Eggs") are how cross-supermarket price comparison works —
// there's no single canonical "item" record, just listings grouped by category.
const groceryProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    supermarket: { type: String, required: true, enum: ["fairprice", "shengsiong", "coldstorage"] },
    category: { type: String, required: true, index: true }, // e.g. "Eggs", "Rice", "Milk"
    searchQuery: { type: String, required: true }, // query used to (re)locate this product on the supermarket site
    packSize: { type: String, default: null },
    imageUrl: { type: String, default: null },
    currentPrice: { type: Number, required: true },
    history: [priceEntrySchema],
    active: { type: Boolean, default: true },
    lastChecked: { type: Date, default: () => new Date() },
    lastCheckFailed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("GroceryProduct", groceryProductSchema);
