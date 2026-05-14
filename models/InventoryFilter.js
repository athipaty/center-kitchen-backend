const mongoose = require("mongoose");

const inventoryFilterSchema = new mongoose.Schema(
  { excluded: { type: [String], default: [] } },
  { timestamps: true }
);

module.exports = mongoose.model("InventoryFilter", inventoryFilterSchema);
