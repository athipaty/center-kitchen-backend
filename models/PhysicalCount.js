const mongoose = require("mongoose");

const PhysicalCountSchema = new mongoose.Schema({
  partNo: String,
  actualQty: Number,
  location: String,
  tagNo: { type: String, unique: true },
  countedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("PhysicalCount", PhysicalCountSchema);
