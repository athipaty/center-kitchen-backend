const mongoose = require('mongoose')

const ProcurementPlanSchema = new mongoose.Schema({
  year:        { type: String, required: true },
  title:       { type: String, required: true },
  fileUrl:     { type: String, required: true },
  fileType:    { type: String, default: 'pdf', enum: ['pdf', 'excel', 'zip'] },
  totalItems:  { type: Number },
  totalBudget: { type: Number },
  period:      { type: String },
  note:        { type: String },
  items: [{
    title:        { type: String },
    budget:       { type: Number },
    budgetSource: { type: String },
    method:       { type: String },
    startPeriod:  { type: String },
  }],
  isActive:    { type: Boolean, default: true },
  publishedAt: { type: Date, default: Date.now },
}, { timestamps: true })

module.exports = mongoose.model('AbtProcurementPlan', ProcurementPlanSchema)
