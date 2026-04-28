const mongoose = require('mongoose')

const AbtNewsSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, default: '' },
  image: { type: String, default: '' },         // Cloudinary URL
  department: {
    type: String,
    required: true,
    enum: [
      'council',      // กิจการสภา
      'office',       // สำนักปลัด
      'childdev',     // ศูนย์พัฒนาเด็กเล็ก
      'disaster',     // ป้องกันและบรรเทาสาธารณภัย
      'health',       // กองสาธารณสุขและสิ่งแวดล้อม
      'engineering',  // กองช่าง
      'finance',      // กองคลัง
    ]
  },
  views: { type: Number, default: 0 },
  publishedAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
}, { timestamps: true })

module.exports = mongoose.model('AbtNews', AbtNewsSchema)