const mongoose = require("mongoose");

const InventorySchema = new mongoose.Schema(
  {
    outletId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    outletName: {
      type: String,
      default: "",
    },
    name: {
      type: String,
      required: true,
    },
    quantity: {
      type: Number,
      default: 0,
    },
    unit: {
      type: String,
      default: "kg",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Inventory", InventorySchema);
