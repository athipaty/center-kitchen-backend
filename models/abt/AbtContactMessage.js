const mongoose = require('mongoose')

const AbtContactMessageSchema = new mongoose.Schema({
  title:     { type: String, required: true },
  message:   { type: String, required: true },
  pageUrl:   { type: String },
  images:    [{ type: String }],
  status:    { type: String, default: 'new', enum: ['new', 'read', 'done'] },
  adminNote: { type: String },
}, { timestamps: true })

module.exports = mongoose.model('AbtContactMessage', AbtContactMessageSchema)
