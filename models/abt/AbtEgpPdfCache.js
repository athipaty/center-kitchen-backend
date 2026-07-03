const mongoose = require('mongoose')

// Cache of agency/budget extracted from nationwide e-GP bid PDFs.
// Separate from AbtEgpItem so it never touches the Maesai-scoped cache/cron.
const schema = new mongoose.Schema({
  link:      { type: String, required: true, unique: true },
  agency:    String,
  budget:    Number,
  enriched:  { type: Boolean, default: false },
}, { timestamps: true })

module.exports = mongoose.model('AbtEgpPdfCache', schema)
