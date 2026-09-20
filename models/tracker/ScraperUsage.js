const mongoose = require("mongoose");

// One doc per ScraperAPI (or free direct-fetch) attempt, not a daily aggregate — keeping
// every event lets the landing page show both the 7-day credit total per ASIN and the last
// few individual check results (tier + outcome), instead of only ever a summed number.
// TTL index clears entries after 30 days.
const scraperUsageSchema = new mongoose.Schema({
  asin: { type: String, required: true, index: true },
  credits: { type: Number, required: true },
  tier: { type: String, enum: ['direct', 'raw', 'autoparse'], required: true },
  createdAt: { type: Date, default: Date.now, expires: 30 * 86400 },
}, { versionKey: false });

scraperUsageSchema.index({ asin: 1, createdAt: -1 });

module.exports = mongoose.model("ScraperUsage", scraperUsageSchema);
