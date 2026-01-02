// models/PushSubscription.js
const mongoose = require("mongoose");

const PushSubscriptionSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true },
    userId: { type: String, required: true },
    subscription: { type: Object, required: true },
  },
  { timestamps: true }
);

PushSubscriptionSchema.index({ roomId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model("PushSubscription", PushSubscriptionSchema);
