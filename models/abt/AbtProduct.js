const mongoose = require('mongoose')

const AbtProductSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  image: { type: String, default: '' },
  images: { type: [String], default: [] },
  price: { type: Number, default: null },
  views: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true })

module.exports = mongoose.model('AbtProduct', AbtProductSchema)