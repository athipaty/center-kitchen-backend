const mongoose = require('mongoose');

// Site-wide settings for the Direk Air shop site, one document (key: 'site'), edited in the shop's admin page.
// theme: id of the colour theme (the site keeps the list of themes)
// phones: shop numbers; the first one is used for the site's "call" buttons
// hours: opening hours text per language
// announcement: optional bar at the top of the site, hidden after `until` (YYYY-MM-DD, Thai time)
// heroPhotoId / heroUrl: optional gallery photo used as the home page's main picture
// Fields left unset fall back to the text already in the site's HTML.
const DirekairSettingSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  theme: { type: String, default: 'ice' },
  phones: {
    type: [{ _id: false, number: String, type: { type: String, enum: ['shop', 'mobile'], default: 'shop' } }],
    default: undefined,
  },
  hours: { th: String, en: String },
  announcement: { enabled: Boolean, th: String, en: String, until: String },
  // gallery photo shown as the big picture at the top of the home page (url copied for a cheap GET)
  heroPhotoId: { type: String, default: '' },
  heroUrl: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('DirekairSetting', DirekairSettingSchema);
