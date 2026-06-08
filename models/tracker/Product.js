const mongoose = require("mongoose");

const priceEntrySchema = new mongoose.Schema(
  {
    price: { type: Number, required: true },
  },
  { timestamps: true }
);

const productSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    image: { type: String, default: null },
    images: { type: [String], default: [] },
    upc: { type: String, default: null },
    currency: { type: String, default: "$" },
    current: { type: Number, required: true },
    lowest: { type: Number, required: true },
    listPrice: { type: Number, default: null },
    history: [priceEntrySchema],
    nextCheck: { type: Date, default: () => new Date() },
    isPrime: { type: Boolean, default: false },
    variant: { type: String, default: null },
    groupId: { type: String, default: null, index: true },
    specs: { type: mongoose.Schema.Types.Mixed, default: {} },
    bullets: { type: [String], default: [] },
    ebayListingId: { type: String, default: null },
    listedAt: { type: Date, default: null },
    cloudinaryFolder: { type: String, default: null },
    status: { type: String, enum: ['active', 'out_of_stock', 'unavailable', 'error'], default: 'active' },
    failCount: { type: Number, default: 0 },
    unavailableSince: { type: Date, default: null },
    listFailCount: { type: Number, default: 0 },
    listingBlocked: { type: Boolean, default: false },
    listingBlockReason: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TrackedProduct", productSchema);
