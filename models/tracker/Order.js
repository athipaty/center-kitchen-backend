const mongoose = require("mongoose");

const shippingAddressSchema = new mongoose.Schema(
  {
    name: { type: String, default: null },
    street1: { type: String, default: null },
    street2: { type: String, default: null },
    cityName: { type: String, default: null },
    stateOrProvince: { type: String, default: null },
    postalCode: { type: String, default: null },
    country: { type: String, default: null },
    phone: { type: String, default: null },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    // Not globally unique: an eBay order can contain multiple line items (different
    // ItemID/variation), each captured as its own Order doc — see compound index below.
    ebayOrderId: { type: String, required: true, index: true },
    ebayItemId: { type: String, default: null },
    title: { type: String, default: null },
    variationValue: { type: String, default: null },
    quantity: { type: Number, default: 1 },
    price: { type: Number, default: null },
    buyerUserId: { type: String, default: null },
    buyerName: { type: String, default: null },
    shippingAddress: { type: shippingAddressSchema, default: () => ({}) },
    status: { type: String, enum: ['needs_purchase', 'purchased', 'shipped', 'delivered', 'notified'], default: 'needs_purchase', index: true },
    deliveredAt: { type: Date, default: null },
    amazonOrderId: { type: String, default: null },
    trackingNumber: { type: String, default: null },
    carrier: { type: String, default: null },
    buyerMessageSent: { type: Boolean, default: false },
    buyerMessageText: { type: String, default: null },
    createTimeEbay: { type: Date, default: null },
    // Which shipping-deadline alert tiers have already been sent for this order
    // (e.g. ['warn18h', 'overdue24h']) — prevents re-sending the same LINE alert
    // every time the deadline-check cron runs.
    deadlineAlertsSent: { type: [String], default: [] },
  },
  { timestamps: true }
);

orderSchema.index({ ebayOrderId: 1, ebayItemId: 1, variationValue: 1 }, { unique: true });

module.exports = mongoose.model("Order", orderSchema);
