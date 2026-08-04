const mongoose = require('mongoose')

const AbtVideoSchema = new mongoose.Schema({
  title:      { type: String, required: true },
  youtubeUrl: { type: String, required: true },
  isActive:   { type: Boolean, default: true },
}, { timestamps: true })

module.exports = mongoose.model('AbtVideo', AbtVideoSchema)
