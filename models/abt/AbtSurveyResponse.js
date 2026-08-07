const mongoose = require('mongoose')

const AbtSurveyResponseSchema = new mongoose.Schema({
  serviceUsed: { type: String },
  ratings: {
    process:  { type: Number, required: true, min: 1, max: 5 },
    staff:    { type: Number, required: true, min: 1, max: 5 },
    facility: { type: Number, required: true, min: 1, max: 5 },
    quality:  { type: Number, required: true, min: 1, max: 5 },
  },
  overallScore: { type: Number, min: 1, max: 5 },
  comment:      { type: String },
  name:         { type: String },
  phone:        { type: String },
}, { timestamps: true })

module.exports = mongoose.model('AbtSurveyResponse', AbtSurveyResponseSchema)
