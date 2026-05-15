const mongoose = require('mongoose');

const ForecastSchema = new mongoose.Schema({
  label: { type: String, required: true },       // "Previous" or "Current"
  uploadDate: { type: Date, default: Date.now },
  filename: { type: String },
  rows: [
    {
      customer: String,
      partNo: String,
      quantities: { type: Map, of: Number },     // { "Feb-26": 1000, "Mar-26": 500 }
    }
  ]
});

module.exports = mongoose.model('Forecast', ForecastSchema);