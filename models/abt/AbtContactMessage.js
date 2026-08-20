const mongoose = require('mongoose')

const AbtContactReplySchema = new mongoose.Schema({
  author:  { type: String, default: 'ผู้ดูแลระบบ' },
  message: { type: String, required: true },
}, { timestamps: true })

const AbtContactMessageSchema = new mongoose.Schema({
  title:     { type: String, required: true },
  message:   { type: String, required: true },
  pageUrl:   { type: String },
  images:    [{ type: String }],
  status:    { type: String, default: 'new', enum: ['new', 'read', 'done'] },
  adminNote: { type: String },
  replies:   [AbtContactReplySchema],
}, { timestamps: true })

module.exports = mongoose.model('AbtContactMessage', AbtContactMessageSchema)
