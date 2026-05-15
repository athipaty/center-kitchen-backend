const mongoose = require('mongoose')

const ComplaintSchema = new mongoose.Schema({
  complaintNo:  { type: String, required: true, unique: true },
  type: {
    type: String,
    required: true,
    enum: ['general', 'corruption'],
  },
  citizenName:  { type: String },
  phone:        { type: String },
  isAnonymous:  { type: Boolean, default: false },
  detail:       { type: String, required: true },
  attachments:  [{ type: String }],
  status: {
    type: String,
    default: 'received',
    enum: ['received', 'investigating', 'done', 'rejected'],
  },
  officerNote:  { type: String },
  closedAt:     { type: Date },
}, { timestamps: true })

module.exports = mongoose.model('AbtComplaint', ComplaintSchema)
