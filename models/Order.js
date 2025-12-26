const mongoose = require("mongoose");

const OrderSchema = new mongoose.Schema(
  {
    outletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Outlet",
      required: true,
    },

    outletName: {
      type: String,
      default: "",
    },

    sauce: {
      type: String,
      required: true,
    },

    quantity: {
      type: Number,
      required: true,
      min: 0,
    },

    deliveryDate: {
      type: String,
      required: true,
    },

    status: {
      type: String,
      enum: ["pending", "delivered", "cancelled"],
      default: "pending",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", OrderSchema);
