const mongoose = require("mongoose");

// A smoking spot added by an app user (F5), confirmed or reported by others (F6).
// Devices are stored only as hashes (see routes/smoke/lib.js deviceHash).
const voteSchema = new mongoose.Schema(
  {
    device: { type: String, required: true },
    type: { type: String, required: true, enum: ["here", "gone", "not_allowed", "bad_photo"] },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

const smokeSpotSchema = new mongoose.Schema(
  {
    name: { type: String, default: null, maxlength: 60 },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    location: {
      type: { type: String, enum: ["Point"], required: true },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    sheltered: { type: Boolean, default: false },
    hasAshtray: { type: Boolean, default: false },
    hasSeating: { type: Boolean, default: false },
    photoUrl: { type: String, default: null },
    photoKey: { type: String, default: null },
    photoHidden: { type: Boolean, default: false },
    verdictAtAdd: { type: String, enum: ["green", "amber"], required: true },
    createdBy: { type: String, required: true },
    // One vote per device; a new vote from the same device replaces the old one.
    // Counts and status are derived from votes in routes/smoke/spots.js.
    votes: [voteSchema],
    hereCount: { type: Number, default: 0 },
    goneCount: { type: Number, default: 0 },
    notAllowedCount: { type: Number, default: 0 },
    badPhotoCount: { type: Number, default: 0 },
    status: { type: String, enum: ["unverified", "verified", "hidden"], default: "unverified", index: true },
    lastConfirmedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true, versionKey: false, collection: "smokespots" }
);
smokeSpotSchema.index({ location: "2dsphere" });
smokeSpotSchema.index({ createdBy: 1, createdAt: -1 });

module.exports = mongoose.model("SmokeSpot", smokeSpotSchema);
