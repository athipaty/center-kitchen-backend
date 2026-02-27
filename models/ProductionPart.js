const mongoose = require("mongoose");

const ProductionPartSchema = new mongoose.Schema({
  partNo: { type: String, required: true, trim: true, unique: true },
}, { timestamps: true });

module.exports = mongoose.model("ProductionPart", ProductionPartSchema);