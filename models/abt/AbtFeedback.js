const mongoose = require('mongoose')

const AbtFeedbackSchema = new mongoose.Schema({
  topic:       { type: String },
  message:     { type: String, required: true },
  name:        { type: String },
  phone:       { type: String },
  isAnonymous: { type: Boolean, default: false },
  status:      { type: String, default: 'new', enum: ['new', 'read', 'done'] },
  adminNote:   { type: String },
}, { timestamps: true })

module.exports = mongoose.model('AbtFeedback', AbtFeedbackSchema)
