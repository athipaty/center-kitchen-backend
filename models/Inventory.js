const mongoose = require("mongoose");

const InventorySchema = new mongoose.Schema(
  {
    outletId: {
      type: String,
      required: true,
    },
    outletName: {
      type: String,
      default: "",
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    unit: {
      type: String,
      enum: ["kg", "g", "bottle", "bag", "pcs"],
      default: "kg",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Inventory", InventorySchema);
