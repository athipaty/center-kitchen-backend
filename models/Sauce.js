const mongoose = require("mongoose");

const sauceSchema = new mongoose.Schema(
  {
    sauceName: {
      type: String,
      required: true,
      trim: true,
    },
    outletName: {
      type: String,
      required: true,
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
