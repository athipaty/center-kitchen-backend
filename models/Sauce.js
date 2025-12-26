const mongoose = require("mongoose");

const sauceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true, // 👈 REQUIRED
      trim: true,
    },
    outletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Outlet",
      required: true,
    },
    standardWeightKg: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Sauce", sauceSchema);
