const mongoose = require('mongoose')

const OITSchema = new mongoose.Schema({
  fiscalYear: { type: String, required: true },
  itemNo:     { type: Number, required: true },
  title:      { type: String, required: true },
  category:   { type: String },
  description:{ type: String },
  links: [{
    label: { type: String },
    url:   { type: String },
  }],
  fileUrl:    { type: String },
  fileName:   { type: String },
  status:     { type: String, default: 'pending', enum: ['complete', 'incomplete', 'pending'] },
  note:       { type: String },
}, { timestamps: true })

OITSchema.index({ fiscalYear: 1, itemNo: 1 }, { unique: true })

module.exports = mongoose.model('AbtOIT', OITSchema)
