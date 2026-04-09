const mongoose = require('mongoose');

const StockDataSchema = new mongoose.Schema({
  uploadDate: { type: Date, default: Date.now },

  // Part number mapping
  mapping: [{
    stockPartNo: String,
    systemPartNo: String,
  }],

  // Current stock
  currentStock: [{
    partNo: String,      // system part no (after mapping)
    qty: Number,
  }],

  // Incoming stock (supply)
  incomingStock: [{
    partNo: String,
    qty: Number,
    date: Date,
  }],

  // PO confirmed (firm demand)
  poConfirmed: [{
    partNo: String,
    qty: Number,
    date: Date,
  }],

  // Forecast (soft demand)
  forecast: [{
    partNo: String,
    qty: Number,
    date: Date,
  }],
});

module.exports = mongoose.model('StockData', StockDataSchema);