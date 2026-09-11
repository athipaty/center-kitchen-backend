const mongoose = require("mongoose");

const marketConversationSchema = new mongoose.Schema(
  {
    listing: { type: mongoose.Schema.Types.ObjectId, ref: "MarketListing", required: true, index: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: "MarketUser", required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: "MarketUser", required: true, index: true },
  },
  { timestamps: true }
);

// One conversation per buyer per listing.
marketConversationSchema.index({ listing: 1, buyer: 1 }, { unique: true });

module.exports = mongoose.model("MarketConversation", marketConversationSchema);
