const mongoose = require("mongoose");

// "I'm here now" at a spot, for the "busy now" level. One per device: checking
// in somewhere else moves it. Keyed by the hashed device id; no location is
// stored beyond which spot it is, and MongoDB deletes it after 90 minutes.
const smokeCheckinSchema = new mongoose.Schema(
  {
    _id: { type: String }, // device hash
    spot: { type: String, required: true }, // "c:<community spot id>" or "nea:<NEA id>"
    at: { type: Date, default: () => new Date(), expires: 90 * 60 },
  },
  { versionKey: false, collection: "smokecheckins" }
);
smokeCheckinSchema.index({ spot: 1, at: -1 });

module.exports = mongoose.model("SmokeCheckin", smokeCheckinSchema);
