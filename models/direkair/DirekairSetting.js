const mongoose = require('mongoose');

// Site-wide settings for the Direk Air shop site, one document (key: 'site').
// theme: id of the colour theme the shop admin picked (the site keeps the list of themes).
const DirekairSettingSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  theme: { type: String, default: 'ice' },
}, { timestamps: true });

module.exports = mongoose.model('DirekairSetting', DirekairSettingSchema);
