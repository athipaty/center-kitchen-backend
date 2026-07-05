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
    ebayPrice: { type: Number, default: null }, // last price successfully synced to eBay — used by frontend instead of GetItem
    listedAt: { type: Date, default: null },
    cloudinaryFolder: { type: String, default: null },
    status: { type: String, enum: ['active', 'out_of_stock', 'unavailable', 'error', 'archived'], default: 'active' },
    failCount: { type: Number, default: 0 },
    unavailableSince: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
    listFailCount: { type: Number, default: 0 },
    listingBlocked: { type: Boolean, default: false },
    listingBlockReason: { type: String, default: null },
    // Times an order for this listing/variant has blown eBay's 24h tracking deadline —
    // surfaces chronically-late SKUs so their handling time can be bumped on eBay.
    lateShipmentCount: { type: Number, default: 0 },
    // Set when a zero-view listing gets an automatic retitle rescue attempt — gives it
    // a 7-day second-chance window before auto-end-zero-views actually ends it.
    zeroViewRescueAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TrackedProduct", productSchema);
