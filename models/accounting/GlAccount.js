const mongoose = require('mongoose');

const glAccountSchema = new mongoose.Schema({
  code:    { type: String, required: true },
  name:    { type: String, required: true },
  type:    { type: String, enum: ['Asset','Liability','Equity','Revenue','Expense','Other'], default: 'Other' },
  company: { type: String, default: 'Express' },
}, { timestamps: true });

glAccountSchema.index({ company: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('GlAccount', glAccountSchema);
