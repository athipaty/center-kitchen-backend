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
  // all pictures of the job, in display order. url/fileKey above always mirror the first 'after'
  // picture (the cover) and beforeUrl/beforeKey the first 'before' one, so older readers keep working.
  // Jobs saved before this list existed have it empty; their pictures are url (+ beforeUrl).
  images: {
    type: [{ _id: false, url: String, key: String, kind: { type: String, enum: ['before', 'after'] } }],
    default: undefined,
  },
  beforeUrl: { type: String, default: '' },
  beforeKey: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('DirekairPhoto', DirekairPhotoSchema);
