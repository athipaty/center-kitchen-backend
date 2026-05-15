const mongoose = require('mongoose')

const AbtAnnouncementSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: {
    type: String,
    required: true,
    enum: ['announcement', 'newsletter'], // ข่าวประชาสัมพันธ์ | จดหมายข่าว
  },
  fileUrl: { type: String, default: '' },   // PDF or image link
  image: { type: String, default: '' },     // Cloudinary URL (for newsletter cover)
  isActive: { type: Boolean, default: true },
  publishedAt: { type: Date, default: Date.now },
}, { timestamps: true })

module.exports = mongoose.model('AbtAnnouncement', AbtAnnouncementSchema)