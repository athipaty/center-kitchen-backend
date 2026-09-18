const mongoose = require("mongoose");

// Daily ScraperAPI credit usage per ASIN. _id = "YYYY-MM-DD:ASIN" so a $inc upsert is a
// single atomic write with no read-modify-write race, and a new UTC day just starts a new
// doc — no reset job needed. TTL index clears entries after 30 days.
const scraperUsageSchema = new mongoose.Schema({
  _id: String,
  date: { type: String, index: true }, // YYYY-MM-DD (UTC)
  asin: String,
  credits: { type: Number, default: 0 },
  checks: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 30 * 86400 },
}, { versionKey: false });

module.exports = mongoose.model("ScraperUsage", scraperUsageSchema);
