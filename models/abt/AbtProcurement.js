const mongoose = require('mongoose')

const AbtProcurementSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: {
    type: String,
    required: true,
    enum: ['egp', 'news'], // EGP system | ข่าวจัดซื้อจัดจ้าง
  },
  externalUrl: { type: String, default: '' }, // link to gprocurement.go.th
  fileUrl: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  publishedAt: { type: Date, default: Date.now },
}, { timestamps: true })

module.exports = mongoose.model('AbtProcurement', AbtProcurementSchema)