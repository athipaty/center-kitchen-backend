const mongoose = require("mongoose");

// Smoke Finder usage counters, one document per Singapore day ("2026-10-27").
// Counts only: no locations, no device ids.
const smokeStatSchema = new mongoose.Schema(
  {
    _id: { type: String }, // YYYY-MM-DD, Singapore time
    actives: { type: Number, default: 0 }, // devices that opened the app that day
    newDevices: { type: Number, default: 0 },
    checks: { type: Number, default: 0 },
    nearby: { type: Number, default: 0 },
    spotViews: { type: Number, default: 0 },
    adds: { type: Number, default: 0 },
    checkins: { type: Number, default: 0 }, // "I'm here now"
    votes: {
      here: { type: Number, default: 0 },
      gone: { type: Number, default: 0 },
      not_allowed: { type: Number, default: 0 },
      bad_photo: { type: Number, default: 0 },
    },
  },
  { versionKey: false, collection: "smokestats" }
);

module.exports = mongoose.model("SmokeStat", smokeStatSchema);
