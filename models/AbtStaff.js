const mongoose = require('mongoose')

const AbtStaffSchema = new mongoose.Schema({
  name: { type: String, required: true },
  position: { type: String, required: true },
  department: {
    type: String,
    required: true,
    enum: [
      'executive',    // ผู้บริหาร
      'council',      // สมาชิกสภา
      'office',       // สำนักปลัด
      'finance',      // กองคลัง
      'engineering',  // กองช่าง
      'health',       // กองสาธารณสุขฯ
      'audit',        // หน่วยตรวจสอบภายใน
    ]
  },
  image: { type: String, default: '' },   // Cloudinary URL
  phone: { type: String, default: '' },
  order: { type: Number, default: 0 },    // display order within department
  isActive: { type: Boolean, default: true },
}, { timestamps: true })

module.exports = mongoose.model('AbtStaff', AbtStaffSchema)