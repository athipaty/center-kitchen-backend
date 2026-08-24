const mongoose = require('mongoose');

// One record per eBay variation whose live price didn't match what it should have been,
// written by syncEbayPrice() whenever it overwrites a variation's price with a different
// value. Feeds GET /api/tracker/price-sync-digest so the recurring price-sync audit has
// something to report beyond "it ran" — what it actually had to fix.
const PriceCorrectionSchema = new mongoose.Schema({
  listingId: { type: String, required: true },
  variant: { type: String, default: null },
  fromPrice: { type: Number, required: true },
  toPrice: { type: Number, required: true },
}, { timestamps: true });

module.exports = mongoose.model('PriceCorrection', PriceCorrectionSchema);
