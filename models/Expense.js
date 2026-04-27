const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true },
    category: {
      type: String,
      enum: ['Food', 'Transport', 'Shopping', 'Drink', 'Cigarettes', 'Other'],
      default: 'Other',
    },
    note: { type: String, default: '' },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Expense', expenseSchema);