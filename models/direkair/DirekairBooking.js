const mongoose = require('mongoose');

// Booking requests from the Direk Air shop site's booking form.
// Only the shop admin can read them (they hold customers' names and phone numbers).
const DirekairBookingSchema = new mongoose.Schema({
  name:    { type: String, required: true },
  phone:   { type: String, required: true },
  car:     { type: String, default: '' },
  service: { type: String, default: '' },
  date:    { type: String, default: '' },   // preferred date, YYYY-MM-DD as the customer picked it
  note:    { type: String, default: '' },
  lang:    { type: String, enum: ['th', 'en'], default: 'th' },
  status:  { type: String, enum: ['new', 'confirmed', 'done', 'cancelled'], default: 'new', index: true },
}, { timestamps: true });

module.exports = mongoose.model('DirekairBooking', DirekairBookingSchema);
