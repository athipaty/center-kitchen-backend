const mongoose = require('mongoose')

const AbtBannerSchema = new mongoose.Schema({
  label:  { type: String, required: true },
  sub:    { type: String, default: '' },
  href:   { type: String, default: '#' },
  bg:       { type: String, default: 'linear-gradient(135deg,#1e3a8a,#2563eb)' },
  imageUrl: { type: String, default: '' },
  order:    { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true })

module.exports = mongoose.model('AbtBanner', AbtBannerSchema)
