const mongoose = require("mongoose");

const PreviousDiffSchema = new mongoose.Schema({
  partNo: { type: String, required: true, trim: true, unique: true },
  price: { type: Number, required: true, default: 0 },
  diffN1: { type: Number, required: true, default: 0 },
  diffN2: { type: Number, required: true, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model("PreviousDiff", PreviousDiffSchema);