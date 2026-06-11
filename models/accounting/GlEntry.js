const mongoose = require('mongoose');

const glEntrySchema = new mongoose.Schema({
  code:        { type: String, required: true, index: true },
  date:        { type: Date,   required: true, index: true },
  account:     { type: String, required: true },
  journal:     { type: String, default: '' },
  voucher:     { type: String, default: '' },
  description: { type: String, default: '' },
  debit:       { type: Number, default: 0 },
  credit:      { type: Number, default: 0 },
  status:      { type: String, default: '' },
  company:     { type: String, default: 'Express', index: true },
}, { timestamps: true });

glEntrySchema.index({ company: 1, date: -1 });
glEntrySchema.index({ company: 1, code: 1, date: 1 });

module.exports = mongoose.model('GlEntry', glEntrySchema);
