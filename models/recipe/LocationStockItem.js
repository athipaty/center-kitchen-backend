const mongoose = require("mongoose");

const locationStockItemSchema = new mongoose.Schema(
  {
    location: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    unit: { type: String, default: "g" },
    qty: { type: Number, default: 0 },
  },
  { timestamps: true }
);

locationStockItemSchema.index({ location: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("LocationStockItem", locationStockItemSchema);
