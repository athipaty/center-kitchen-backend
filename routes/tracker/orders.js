const express = require("express");
const router = express.Router();
const axios = require("axios");

const Order = require("../../models/tracker/Order");
const Product = require("../../models/tracker/Product");
const { getAccessToken, bestVariantMatch } = require("../../jobs/ebayPriceSync");

// GET all orders — newest eBay sale first
router.get("/", async (req, res) => {
  try {
    const orders = await Order.find().sort({ createTimeEbay: -1, createdAt: -1 });

    // Attach the matching Amazon product URL for each order's item/variant, same
    // matching logic used to restock the right variant after a sale.
    const itemIds = [...new Set(orders.map(o => o.ebayItemId).filter(Boolean))];
    const products = await Product.find({ ebayListingId: { $in: itemIds } }, { url: 1, ebayListingId: 1, variant: 1, image: 1 }).lean();
    const productsByListing = {};
    for (const p of products) (productsByListing[p.ebayListingId] ||= []).push(p);

    const results = orders.map(o => {
      const candidates = productsByListing[o.ebayItemId] || [];
      const match = candidates.length
        ? (o.variationValue ? bestVariantMatch(candidates, o.variationValue) : candidates[0])
        : null;
      return { ...o.toObject(), amazonUrl: match?.url || null, productImage: match?.image || null };
    });

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE remove an order from the list once it's fully handled
router.delete("/:id", async (req, res) => {
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ error: "order not found" });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH mark an order as purchased on Amazon
router.patch("/:id/purchased", async (req, res) => {
  try {
    const { amazonOrderId } = req.body;
    if (!amazonOrderId) return res.status(400).json({ error: "amazonOrderId is required" });
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { amazonOrderId, status: 'purchased' },
      { new: true }
    );
    if (!order) return res.status(404).json({ error: "order not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH add a tracking number — pushes it to the live eBay order via the Fulfillment API
router.patch("/:id/tracking", async (req, res) => {
  try {
    const { trackingNumber, carrier } = req.body;
    if (!trackingNumber || !carrier) return res.status(400).json({ error: "trackingNumber and carrier are required" });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "order not found" });

    const token = await getAccessToken();
    const { data: ebayOrder } = await axios.get(
      `https://api.ebay.com/sell/fulfillment/v1/order/${encodeURIComponent(order.ebayOrderId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const line = (ebayOrder.lineItems || []).find(l => l.legacyItemId === order.ebayItemId) || ebayOrder.lineItems?.[0];
    if (!line) return res.status(502).json({ error: "could not find matching eBay line item for this order" });

    await axios.post(
      `https://api.ebay.com/sell/fulfillment/v1/order/${encodeURIComponent(order.ebayOrderId)}/shipping_fulfillment`,
      {
        lineItems: [{ lineItemId: line.lineItemId, quantity: order.quantity || 1 }],
        shippedDate: new Date().toISOString(),
        shippingCarrierCode: carrier,
        trackingNumber,
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    order.trackingNumber = trackingNumber;
    order.carrier = carrier;
    order.status = 'shipped';
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(err.response?.status === 401 ? 401 : 500).json({ error: err.response?.data?.errors?.[0]?.message || err.message });
  }
});

// POST compose a thank-you message for the buyer — just generates the text for you
// to copy and paste into eBay's message center yourself (eBay's buyer-messaging API
// is legacy and unreliable, so this skips trying to auto-send entirely).
router.post("/:id/notify-buyer", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "order not found" });
    if (!order.trackingNumber) return res.status(400).json({ error: "add a tracking number before notifying the buyer" });

    const buyerFirstName = order.shippingAddress?.name?.trim().split(' ')[0] || null;
    const messageText = `Hi${buyerFirstName ? ` ${buyerFirstName}` : ''}! Just letting you know your order has been delivered 📦 ` +
      `Thanks so much for shopping with us — we'd love to hear your feedback! 🙏`;

    order.buyerMessageText = messageText;
    order.buyerMessageSent = true;
    order.status = 'notified';
    await order.save();
    res.json({ messageText, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
