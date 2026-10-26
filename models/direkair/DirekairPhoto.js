const mongoose = require('mongoose');

// Customer-work photos shown in the "ผลงานของเรา" gallery on the Direk Air shop site.
// Image bytes live in B2 under direkair-gallery/; this only keeps the URL and display info.
const DirekairPhotoSchema = new mongoose.Schema({
  url:     { type: String, required: true },
  fileKey: { type: String, required: true },
  caption: { type: String, default: '' },
  order:   { type: Number, default: 0 }, // lower shows first
  // which service the job was: lets the site filter the gallery
  category: { type: String, enum: ['aircon', 'carryboy', 'tint', 'audio', 'other'], default: 'other' },
  // optional "before" photo for a before/after pair
  beforeUrl: { type: String, default: '' },
  beforeKey: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('DirekairPhoto', DirekairPhotoSchema);
