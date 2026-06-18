const mongoose = require('mongoose');

// Persists ScraperAPI structured product responses across server restarts.
// Keyed by ASIN (_id). TTL index auto-deletes expired entries from MongoDB.
const scraperCacheSchema = new mongoose.Schema({
  _id: String,           // ASIN
  data: mongoose.Schema.Types.Mixed,
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, { _id: false, timestamps: false, versionKey: false });

module.exports = mongoose.model('ScraperCache', scraperCacheSchema);
