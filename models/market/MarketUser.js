const mongoose = require("mongoose");

const marketUserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true },
    // GeoJSON Point, [lng, lat]. Optional — a user can register without
    // sharing a location. No defaults here: a default on the nested `type`
    // field fires even when `location` itself is never set, leaving a
    // half-formed { type: "Point" } with no coordinates that the 2dsphere
    // index below rejects. The app always supplies both fields together
    // (see toLocation() in routes/market/auth.js) or neither.
    location: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number] },
    },
    locationName: { type: String, default: null },
  },
  { timestamps: true }
);

marketUserSchema.index({ location: "2dsphere" });

module.exports = mongoose.model("MarketUser", marketUserSchema);
