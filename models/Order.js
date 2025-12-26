const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    // 🔐 NEW: strong relationship
    outletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Outlet",
      required: false, // TEMP: allow old data
      index: true,
    },

    // ⚠️ TEMP: keep for backward compatibility
    outletName: {
      type: String,
      required: true,
    },

    sauce: {
      type: String,
      required: true,
    },

    quantity: {
      type: Number,
      required: true,
    },

    deliveryDate: {
      type: String,
      required: true,
    },

    status: {
      type: String,
      enum: ["pending", "delivered"],
      default: "pending",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Order", orderSchema);
