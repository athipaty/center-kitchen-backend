const mongoose = require('mongoose');

const contactReportSchema = new mongoose.Schema({
  subject:     { type: String, required: true },
  description: { type: String, required: true },
  imageUrl:    { type: String, default: '' },
  status:      { type: String, default: 'open', enum: ['open','resolved'] },
  company:     { type: String, default: 'Express' },
}, { timestamps: true });

module.exports = mongoose.model('ContactReport', contactReportSchema);
