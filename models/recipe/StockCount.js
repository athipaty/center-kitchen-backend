const mongoose = require("mongoose");

const stockCountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    qty: { type: Number, default: 0 },
    unit: { type: String, default: "g" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("StockCount", stockCountSchema);
