const mongoose = require('mongoose')

const schema = new mongoose.Schema({
  link:        { type: String, required: true, unique: true },
  anounceType: { type: String, required: true },
  title:       String,
  date:        Date,
  desc:        String,
  winner:      String,
  amount:      Number,
  method:      String,
  enriched:    { type: Boolean, default: false },
}, { timestamps: true })

schema.index({ anounceType: 1, date: -1 })

module.exports = mongoose.model('AbtEgpItem', schema)
