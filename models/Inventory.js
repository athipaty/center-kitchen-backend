const mongoose = require("mongoose");

const inventorySchema = new mongoose.Schema(
  {
    outletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Outlet",
      required: true,
      index: true,
    },

    outletName: {
      type: String,
      required: true,
      trim: true,
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
      required: true,
      trim: true,
      default: "kg",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Inventory", inventorySchema);
