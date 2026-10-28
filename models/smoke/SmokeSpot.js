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

// "Is it sheltered / is there an ashtray / seats?" from people other than the
// adder. One per device and feature; see tallyFeatures in routes/smoke/spots.js.
const featureVoteSchema = new mongoose.Schema(
  {
    device: { type: String, required: true },
    feature: { type: String, required: true, enum: ["sheltered", "hasAshtray", "hasSeating"] },
    value: { type: Boolean, required: true },
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
    // What the adder (or a moderator's edit) said; counts as one vote in tallyFeatures.
    featuresAtAdd: {
      sheltered: { type: Boolean },
      hasAshtray: { type: Boolean },
      hasSeating: { type: Boolean },
    },
    featureVotes: [featureVoteSchema],
    // Opening hours as the adder typed them ("7am-11pm"), "24h", or null (unknown).
    hours: { type: String, default: null, maxlength: 40 },
    photoUrl: { type: String, default: null },
    photoKey: { type: String, default: null },
    photoHidden: { type: Boolean, default: false },
    photoAdminHidden: { type: Boolean, default: false }, // a moderator's call; votes can't undo it
    verdictAtAdd: { type: String, enum: ["green", "amber"], required: true },
    createdBy: { type: String, required: true },
    // "user": added in the app. Otherwise a designated smoking area from an
    // operator's own list, which gives descriptions, not positions:
    // "sdc" Sentosa Development Corporation, "ntu" Nanyang Technological University.
    source: { type: String, enum: ["user", "sdc", "ntu"], default: "user" },
    // Placed at the nearest landmark, not surveyed: the app says "look for the sign".
    approximate: { type: Boolean, default: false },
    // Added by a moderator (seeding spots they know): counts as verified.
    addedByModerator: { type: Boolean, default: false },
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
