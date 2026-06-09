const mongoose = require('mongoose');

const EbayTokenSchema = new mongoose.Schema({
  _id: { type: String, default: 'ebay' },
  access_token:             { type: String, default: null },
  refresh_token:            { type: String, default: null },
  expires_at:               { type: Number, default: 0 },
  refresh_token_expires_at: { type: Number, default: 0 },
  // Day-of-month eBay's selling-limit cycle resets on (eBay doesn't expose this via any API —
  // calibrated by comparing our estimate against the real number shown in Seller Hub).
  limitCycleStartDay:       { type: Number, default: null },
}, { _id: false });

module.exports = mongoose.model('EbayToken', EbayTokenSchema);
