const mongoose = require('mongoose')

const EServiceTypeSchema = new mongoose.Schema({
  value:    { type: String, required: true, unique: true },
  label:    { type: String, required: true },
  icon:     { type: String, default: '📝' },
  order:    { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true })

module.exports = mongoose.model('AbtEServiceType', EServiceTypeSchema)
