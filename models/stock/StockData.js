const mongoose = require('mongoose');

const StockDataSchema = new mongoose.Schema({
  uploadDate: { type: Date, default: Date.now },
  mapping: [{ stockPartNo: String, systemPartNo: String }],
  currentStock: [{ partNo: String, qty: Number }],
  incomingStock: [{
    partNo: String,
    invoiceNo: String,
    poNo: String,
    qty: Number,
    date: Date,
  }],
  poConfirmed: [{
    customer: String,
    partNo: String,
    qty: Number,
    date: Date,
  }],
  forecast: [{
    customer: String,
    partNo: String,
    qty: Number,
    date: Date,
  }],
  excludedParts: [{ partNo: String }],
});

module.exports = mongoose.model('StockData', StockDataSchema);