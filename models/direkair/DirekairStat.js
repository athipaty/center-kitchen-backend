const mongoose = require('mongoose');

// Daily counters for the Direk Air shop site: page visits and taps on call / LINE / map, plus bookings.
// Counts only: no IP addresses, user agents or anything that identifies a visitor is stored.
// day is the date in Thai time (YYYY-MM-DD).
const DirekairStatSchema = new mongoose.Schema({
  day:   { type: String, required: true },
  event: { type: String, required: true, enum: ['visit', 'call', 'line', 'map', 'booking'] },
  lang:  { type: String, enum: ['th', 'en'], default: 'th' },
  n:     { type: Number, default: 0 },
});
DirekairStatSchema.index({ day: 1, event: 1, lang: 1 }, { unique: true });

module.exports = mongoose.model('DirekairStat', DirekairStatSchema);
