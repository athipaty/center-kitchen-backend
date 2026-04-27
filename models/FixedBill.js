const mongoose = require('mongoose');

const fixedBillSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    amount: { type: Number, required: true },
    order: { type: Number, default: 0 }, // priority order to fill
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('FixedBill', fixedBillSchema);