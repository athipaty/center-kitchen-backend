const mongoose = require("mongoose");

// NEA designated smoking area (data.gov.sg), written by smoke-finder's `npm run import`.
const smokeDsaSchema = new mongoose.Schema(
  {
    neaId: { type: Number, required: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    photo: { type: String, default: null },
    lat: Number,
    lng: Number,
    x: Number, // engine's local metre grid
    y: Number,
    location: {
      type: { type: String, enum: ["Point"], required: true },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
  },
  { versionKey: false, collection: "smokedsas" }
);
smokeDsaSchema.index({ location: "2dsphere" });

module.exports = mongoose.model("SmokeDsa", smokeDsaSchema);
