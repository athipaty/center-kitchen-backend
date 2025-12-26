// models/Sauce.js
const mongoose = require("mongoose");

const SauceSchema = new mongoose.Schema({
  outletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Outlet",
    required: true,
  },
  name: { type: String, required: true },
  standardWeightKg: { type: Number, required: true },
}, { timestamps: true });

module.exports = mongoose.model("Sauce", SauceSchema);
