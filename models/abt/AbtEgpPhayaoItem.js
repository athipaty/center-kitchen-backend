const mongoose = require('mongoose')

// Nationwide e-GP announcements filtered down to those mentioning พะเยา, across all
// announcement types. projectId groups multiple announcements (plan/draft/invite/winner)
// that belong to the same procurement into one card.
const schema = new mongoose.Schema({
  link:        { type: String, required: true, unique: true },
  projectId:   String,
  anounceType: { type: String, required: true },
  title:       String,
  date:        Date,
  desc:        String,
  agency:      String,
  budget:      Number,
  winner:      String,
  amount:      Number,
  method:      String,
  closingDate: Date,
  matchedProvince: String,
  enriched:    { type: Boolean, default: false },
}, { timestamps: true })

schema.index({ projectId: 1, date: -1 })
schema.index({ anounceType: 1, date: -1 })

module.exports = mongoose.model('AbtEgpPhayaoItem', schema)
