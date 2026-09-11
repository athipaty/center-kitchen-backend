const mongoose = require("mongoose");

const marketMessageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "MarketConversation", required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "MarketUser", required: true },
    body: { type: String, required: true, maxlength: 2000 },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MarketMessage", marketMessageSchema);
