const mongoose = require('mongoose');

// Caches eBay Taxonomy API responses per category ID.
// Category aspects change rarely (monthly at most) — caching avoids one
// eBay API call per aspect injection + enrichment per listing created.
const schema = new mongoose.Schema({
  _id: String,        // categoryId
  aspects: mongoose.Schema.Types.Mixed,
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, { _id: false, timestamps: false, versionKey: false });

module.exports = mongoose.model('EbayAspectsCache', schema);
