const mongoose = require('mongoose')

const AbtNewsSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, default: '' },
  image: { type: String, default: '' },
  images: { type: [String], default: [] },
  department: {
    type: String,
    required: true,
    enum: ['council', 'office', 'childdev', 'disaster', 'health', 'engineering', 'finance']
  },
  views: { type: Number, default: 0 },
  publishedAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
}, { timestamps: true })

module.exports = mongoose.model('AbtNews', AbtNewsSchema)