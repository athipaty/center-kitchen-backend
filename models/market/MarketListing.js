const mongoose = require("mongoose");

const marketListingSchema = new mongoose.Schema(
  {
    seller: { type: mongoose.Schema.Types.ObjectId, ref: "MarketUser", required: true, index: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    category: { type: String, required: true, index: true },
    images: { type: [String], default: [] },
    // GeoJSON Point, [lng, lat] — required for 2dsphere geo queries.
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true },
    },
    locationName: { type: String, default: null },
    status: { type: String, enum: ["ACTIVE", "SOLD", "REMOVED"], default: "ACTIVE", index: true },
  },
  { timestamps: true }
);

marketListingSchema.index({ location: "2dsphere" });

module.exports = mongoose.model("MarketListing", marketListingSchema);
