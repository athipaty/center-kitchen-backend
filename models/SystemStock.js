const mongoose = require("mongoose");

const SystemStockSchema = new mongoose.Schema({
  partNo: { type: String, required: true },
  systemQty: { type: Number, required: true }
});

module.exports = mongoose.model("SystemStock", SystemStockSchema);
