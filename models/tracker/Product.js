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
    // Structured per-dimension breakdown of `variant` (e.g. [{dimension:"Color",value:"Grey"},
    // {dimension:"PackageQuantity",value:"24"}]) — populated when Keepa exposes >=1 variation
    // axis for this ASIN. Lets eBay listing creation build true multi-dimension variations
    // instead of guessing a single dimension from the flattened `variant` string.
    attributes: { type: [{ dimension: String, value: String, _id: false }], default: [] },
    groupId: { type: String, default: null, index: true },
    specs: { type: mongoose.Schema.Types.Mixed, default: {} },
    bullets: { type: [String], default: [] },
    ebayListingId: { type: String, default: null },
    ebayPrice: { type: Number, default: null }, // last price successfully synced to eBay — used by frontend instead of GetItem
    listedAt: { type: Date, default: null },
    cloudinaryFolder: { type: String, default: null },
    // Amazon image ID of this product's own hero/first gallery photo, as last scraped.
    // Persisted (not just kept in-memory) so a re-scrape of a sibling in the same group
    // can reliably filter out THIS product's hero if it leaks into the sibling's gallery,
    // regardless of process restarts or which sibling gets scraped first.
    heroImageId: { type: String, default: null },
    status: { type: String, enum: ['active', 'out_of_stock', 'unavailable', 'error', 'archived'], default: 'active' },
    failCount: { type: Number, default: 0 },
    unavailableSince: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
    listFailCount: { type: Number, default: 0 },
    listingBlocked: { type: Boolean, default: false },
    listingBlockReason: { type: String, default: null },
    // Live progress marker for the client-driven auto-list flow (preparing-images → title →
    // images → description → listing → photos → verifying → saving — see ProductGroupCard's
    // autoListOnEbay). The whole flow runs as sequential fetches from the browser, not a
    // backend job, so if the tab is refreshed/closed mid-flow nothing resumes it — these two
    // fields just let the UI show "still under listing" (or "stalled" once stale) after a
    // reload, instead of the in-progress state silently vanishing with the page's JS memory.
    autoListStep: { type: String, default: null },
    autoListStepAt: { type: Date, default: null },
    // Times an order for this listing/variant has blown eBay's 48h tracking deadline —
    // surfaces chronically-late SKUs so their handling time can be bumped on eBay.
    lateShipmentCount: { type: Number, default: 0 },
    // Amazon's "Ships from" / "Sold by" at the time this product was added — isAmazonFulfilled
    // flags FBA (Amazon warehouse ships it, even for 3rd-party brands), which is the source of
    // eBay-unvalidatable TBA/Amazon-Logistics tracking numbers. null = unknown (fetch failed).
    shipsFrom: { type: String, default: null },
    soldBy: { type: String, default: null },
    isAmazonFulfilled: { type: Boolean, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TrackedProduct", productSchema);
