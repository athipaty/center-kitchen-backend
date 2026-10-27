const mongoose = require("mongoose");

// One no-smoking place (bus stop, park, building, ...) for the smoke-finder app.
// Written in bulk by smoke-finder's `npm run import`, never edited by the API.
// x/y/r, rings and path are in the engine's local metre grid; `area` is the
// zone's bounding box plus its legal buffer, in lng/lat, used only to find
// candidates near a point.
const smokeZoneSchema = new mongoose.Schema(
  {
    rule: { type: String, required: true, index: true }, // see smoke-finder src/rules.js
    kind: { type: String, required: true, enum: ["circle", "poly", "line"] },
    name: { type: String, default: null },
    osm: { type: String, default: null }, // e.g. "way/123", null for derived zones
    x: Number,
    y: Number,
    r: Number,
    rings: [[Number]],
    path: [Number],
    bbox: [Number],
    area: {
      type: { type: String, enum: ["Polygon"], required: true },
      coordinates: { type: [[[Number]]], required: true },
    },
  },
  { versionKey: false, collection: "smokezones" }
);
smokeZoneSchema.index({ area: "2dsphere" });

module.exports = mongoose.model("SmokeZone", smokeZoneSchema);
