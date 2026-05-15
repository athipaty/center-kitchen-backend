const mongoose = require('mongoose')

const EServiceSchema = new mongoose.Schema({
  requestNo:   { type: String, required: true, unique: true },
  type: { type: String, required: true },
  citizenName: { type: String, required: true },
  phone:       { type: String, required: true },
  address:     { type: String },
  villageNo:   { type: String },
  detail:      { type: String, required: true },
  images:      [{ type: String }],
  status: {
    type: String,
    default: 'received',
    enum: ['received', 'in_progress', 'done', 'rejected'],
  },
  officerNote: { type: String },
  closedAt:    { type: Date },
}, { timestamps: true })

module.exports = mongoose.model('AbtEService', EServiceSchema)
