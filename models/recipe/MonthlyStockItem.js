const mongoose = require("mongoose");

const monthlyStockItemSchema = new mongoose.Schema(
  {
    supplier: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    unit: { type: String, default: "" },
    qty: { type: Number, default: 0 },
  },
  { timestamps: true }
);

monthlyStockItemSchema.index({ supplier: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("MonthlyStockItem", monthlyStockItemSchema);
