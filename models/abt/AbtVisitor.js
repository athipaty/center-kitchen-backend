const mongoose = require('mongoose')

const AbtVisitorSchema = new mongoose.Schema({
  date:  { type: String, required: true, unique: true }, // 'YYYY-MM-DD'
  count: { type: Number, default: 0 },
}, { timestamps: true })

module.exports = mongoose.model('AbtVisitor', AbtVisitorSchema)
