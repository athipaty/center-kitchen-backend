const mongoose = require("mongoose");

// Embervale market board (routes/embervale/market.js): items players put up for sale, held by the server
// until someone buys them or the seller takes them back, and each seller's purse of unclaimed sales.
// Stored in their own "ember_market" and "ember_market_purse" collections.
const listingSchema = new mongoose.Schema(
  {
    seller: { type: String, required: true },          // account username
    sellerName: { type: String, default: "" },         // character name when listed
    e: { type: mongoose.Schema.Types.Mixed, required: true }, // the item entry: {id, n} or {id, s, r}
    price: { type: Number, required: true, min: 1 },
  },
  { timestamps: true, minimize: false }
);
listingSchema.index({ seller: 1 });
listingSchema.index({ createdAt: -1 });

const purseSchema = new mongoose.Schema(
  {
    seller: { type: String, required: true, unique: true },
    gold: { type: Number, default: 0 },
    log: { type: [mongoose.Schema.Types.Mixed], default: [] }, // last sales: {e, price, buyer, at}
  },
  { timestamps: true, minimize: false }
);

module.exports = {
  EmberListing: mongoose.model("EmberListing", listingSchema, "ember_market"),
  EmberPurse: mongoose.model("EmberPurse", purseSchema, "ember_market_purse"),
};
