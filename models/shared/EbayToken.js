const mongoose = require('mongoose');

const EbayTokenSchema = new mongoose.Schema({
  _id: { type: String, default: 'ebay' },
  access_token:  { type: String, default: null },
  refresh_token: { type: String, default: null },
  expires_at:    { type: Number, default: 0 },
}, { _id: false });

module.exports = mongoose.model('EbayToken', EbayTokenSchema);
