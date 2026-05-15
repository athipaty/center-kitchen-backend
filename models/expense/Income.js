const mongoose = require('mongoose');

const incomeSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true },
    note: { type: String, default: '' },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Income', incomeSchema);