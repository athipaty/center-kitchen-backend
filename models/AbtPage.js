const mongoose = require('mongoose')

const BlockSchema = new mongoose.Schema({
  type: { type: String, required: true }, // text | links | cards | image | table
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: true })

const AbtPageSchema = new mongoose.Schema({
  title:      { type: String, required: true },
  slug:       { type: String, required: true, unique: true },
  icon:       { type: String, default: '📄' },
  parentSlug: { type: String, default: '' },
  order:      { type: Number, default: 0 },
  isActive:   { type: Boolean, default: true },
  isBuiltin:  { type: Boolean, default: false },
  path:       { type: String, default: '' }, // builtin: React route; custom: /page/:slug
  blocks:     [BlockSchema],
}, { timestamps: true })

module.exports = mongoose.model('AbtPage', AbtPageSchema)
