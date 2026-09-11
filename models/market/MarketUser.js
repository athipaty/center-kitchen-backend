const mongoose = require("mongoose");

const marketUserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true },
    // GeoJSON Point, [lng, lat] — required for 2dsphere geo queries.
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], default: undefined },
    },
    locationName: { type: String, default: null },
  },
  { timestamps: true }
);

marketUserSchema.index({ location: "2dsphere" });

module.exports = mongoose.model("MarketUser", marketUserSchema);
