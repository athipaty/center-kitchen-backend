const mongoose = require('mongoose')

const schema = new mongoose.Schema({
  title:       { type: String, required: true },
  topic:       { type: String, default: '' },
  fileUrl:     { type: String, default: '' },
  isActive:    { type: Boolean, default: true },
  publishedAt: { type: Date, default: Date.now },
}, { timestamps: true })

schema.index({ publishedAt: -1 })

module.exports = mongoose.model('AbtNotice', schema)
