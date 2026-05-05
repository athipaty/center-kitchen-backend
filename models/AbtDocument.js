const mongoose = require('mongoose')

const DocumentSchema = new mongoose.Schema({
  title:       { type: String, required: true },
  category: {
    type: String,
    required: true,
    enum: [
      'finance',        // การเงินและบัญชี
      'budget',         // งบประมาณ
      'hr',             // บริหารทรัพยากรบุคคล
      'council',        // กิจการสภา
      'audit',          // ตรวจสอบภายใน
      'risk',           // บริหารความเสี่ยง
      'law',            // กฎหมาย/ข้อบัญญัติ
      'integrity',      // ป้องกันทุจริต / No Gift Policy
      'other',
    ],
  },
  fiscalYear:  { type: String },
  description: { type: String },
  fileUrl:     { type: String, required: true },
  fileType:    { type: String, default: 'pdf', enum: ['pdf', 'excel', 'word', 'zip', 'other'] },
  isActive:    { type: Boolean, default: true },
  publishedAt: { type: Date, default: Date.now },
}, { timestamps: true })

module.exports = mongoose.model('AbtDocument', DocumentSchema)
