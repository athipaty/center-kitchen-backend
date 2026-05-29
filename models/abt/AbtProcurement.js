const mongoose = require('mongoose')

const AbtProcurementSchema = new mongoose.Schema({
  title:       { type: String, required: true },
  type:        { type: String, required: true, enum: ['egp', 'news'] },
  externalUrl: { type: String, default: '' },
  fileUrl:     { type: String, default: '' },
  winner:      { type: String, default: '' },   // ผู้ชนะการเสนอราคา
  amount:      { type: Number, default: null },  // ราคาที่เสนอ / ราคาสุทธิ (บาท)
  budget:      { type: Number, default: null },  // วงเงินงบประมาณ / ราคากลาง (บาท)
  method:      { type: String, default: '' },    // วิธีการจัดหา
  isActive:    { type: Boolean, default: true },
  publishedAt: { type: Date, default: Date.now },
}, { timestamps: true })

module.exports = mongoose.model('AbtProcurement', AbtProcurementSchema)