const express = require("express");
const router = express.Router();
const axios = require("axios");

const Order = require("../../models/tracker/Order");
const Product = require("../../models/tracker/Product");
const { getAccessToken, bestVariantMatch } = require("../../jobs/ebayPriceSync");

// eBay expects tracking uploaded within this many hours of payment (handling time) —
// past this, the order counts as a late shipment against seller performance metrics.
const SHIP_DEADLINE_HOURS = 48;

// Delivered/notified orders drop off the page this long after delivery — the DB record
// stays (Remove is still manual/explicit), this just keeps the list from filling up with
// fully-handled orders. Falls back to updatedAt for orders delivered before deliveredAt existed.
const DELIVERED_RETENTION_DAYS = 1;

// Shared by GET / and POST /check-new — orders still needing tracking sort by
// closest-to-deadline first (overdue ones on top), so what needs action is always at
// the top of the list. Already-shipped orders follow, newest sale first. Delivered/
// notified orders older than DELIVERED_RETENTION_DAYS are excluded entirely.
async function getOrdersList() {
  const cutoff = new Date(Date.now() - DELIVERED_RETENTION_DAYS * 86400000);
  const orders = await Order.find({
    $or: [
      { status: { $nin: ['delivered', 'notified'] } },
      { deliveredAt: { $gt: cutoff } },
      { deliveredAt: null, updatedAt: { $gt: cutoff } },
    ],
  }).sort({ createTimeEbay: -1, createdAt: -1 });

  // Amazon URL/image are snapshotted onto the order at capture time (see order-capture
  // in trackerScheduler.js) so they survive the product's ebayListingId later changing
  // on relist. Only fall back to a live join for older orders captured before that
  // snapshot existed — which breaks if their product has since been relisted, same as
  // before this fix.
  const legacyOrders = orders.filter(o => !o.amazonUrl && !o.productImage);
  const itemIds = [...new Set(legacyOrders.map(o => o.ebayItemId).filter(Boolean))];
  const products = itemIds.length
    ? await Product.find({ ebayListingId: { $in: itemIds } }, { url: 1, ebayListingId: 1, variant: 1, image: 1 }).lean()
    : [];
  const productsByListing = {};
  for (const p of products) (productsByListing[p.ebayListingId] ||= []).push(p);

  const now = Date.now();
  const results = orders.map(o => {
    let amazonUrl = o.amazonUrl || null;
    let productImage = o.productImage || null;
    if (!amazonUrl && !productImage) {
      const candidates = productsByListing[o.ebayItemId] || [];
      const match = candidates.length
        ? (o.variationValue ? bestVariantMatch(candidates, o.variationValue) : candidates[0])
        : null;
      amazonUrl = match?.url || null;
      productImage = match?.image || null;
    }

    const shipDeadline = o.createTimeEbay
      ? new Date(o.createTimeEbay.getTime() + SHIP_DEADLINE_HOURS * 3600 * 1000)
      : null;
    const hasTracking = Boolean(o.trackingNumber);
    const hoursLeft = shipDeadline && !hasTracking ? (shipDeadline.getTime() - now) / 3600000 : null;

    return {
      ...o.toObject(),
      amazonUrl,
      productImage,
      shipDeadline,
      hoursLeft,
      isOverdue: hoursLeft != null && hoursLeft <= 0,
    };
  });

  results.sort((a, b) => {
    const aUrgent = a.hoursLeft != null;
    const bUrgent = b.hoursLeft != null;
    if (aUrgent && bUrgent) return a.hoursLeft - b.hoursLeft; // soonest/most-overdue deadline first
    if (aUrgent !== bUrgent) return aUrgent ? -1 : 1; // needs-tracking orders before shipped ones
    return new Date(b.createTimeEbay || b.createdAt) - new Date(a.createTimeEbay || a.createdAt);
  });

  return results;
}

// GET all orders straight from the DB — see getOrdersList() for sort/shape.
router.get("/", async (req, res) => {
  try {
    res.json(await getOrdersList());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST check-new — actually polls eBay for orders placed since the last run (same
// GetOrders call the 30-min auto-restock cron makes) before returning the list, so the
// "Check for new orders" button reflects a real eBay check instead of just re-reading
// whatever the DB already had. No-ops safely if eBay is currently rate-limited.
router.post("/check-new", async (req, res) => {
  try {
    const { autoRestock } = require("../../jobs/trackerScheduler");
    await autoRestock();
    res.json(await getOrdersList());
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

// PATCH mark an order delivered — a manual checkpoint (e.g. confirmed via the carrier's
// tracking page or an Amazon delivery-confirmation email) between "shipped" and
// actually messaging the buyer, since notifying before delivery is confirmed would be
// premature.
router.patch("/:id/delivered", async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status: 'delivered', deliveredAt: new Date() },
      { new: true }
    );
    if (!order) return res.status(404).json({ error: "order not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH undo an accidental "mark delivered" click — reverts back to shipped. Only
// valid from 'delivered' (not 'notified': once the buyer's been messaged about delivery,
// reverting would leave that message contradicting the order's own status).
router.patch("/:id/undo-delivered", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "order not found" });
    if (order.status !== 'delivered') return res.status(400).json({ error: "order is not marked delivered" });

    order.status = 'shipped';
    order.deliveredAt = null;
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST compose a thank-you message for the buyer — just generates the text for you
// to copy and paste into eBay's message center yourself (eBay's buyer-messaging API
// is legacy and unreliable, so this skips trying to auto-send entirely).
router.post("/:id/notify-buyer", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "order not found" });
    if (order.status !== 'delivered') return res.status(400).json({ error: "mark the order delivered before messaging the buyer" });

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

// ── One-time backfill: populate amazonUrl/productImage for orders captured before
// this snapshot existed. Uses the same live-join logic the GET / route falls back to —
// running this now, before any further relists happen, locks in a correct match for
// orders whose product hasn't been relisted yet (orders whose product was already
// relisted before this backfill runs have no way to recover their original match).
router.post("/backfill-product-links", async (req, res) => {
  try {
    const orders = await Order.find(
      { $or: [{ amazonUrl: null }, { amazonUrl: { $exists: false } }] },
      'ebayItemId variationValue'
    ).lean();
    if (!orders.length) return res.json({ ok: true, updated: 0, message: 'Nothing to backfill' });

    const itemIds = [...new Set(orders.map(o => o.ebayItemId).filter(Boolean))];
    const products = await Product.find({ ebayListingId: { $in: itemIds } }, { url: 1, ebayListingId: 1, variant: 1, image: 1 }).lean();
    const productsByListing = {};
    for (const p of products) (productsByListing[p.ebayListingId] ||= []).push(p);

    let updated = 0, notFound = 0;
    for (const o of orders) {
      const candidates = productsByListing[o.ebayItemId] || [];
      const match = candidates.length
        ? (o.variationValue ? bestVariantMatch(candidates, o.variationValue) : candidates[0])
        : null;
      if (!match) { notFound++; continue; }
      await Order.findByIdAndUpdate(o._id, { amazonUrl: match.url || null, productImage: match.image || null });
      updated++;
    }

    res.json({ ok: true, candidates: orders.length, updated, notMatched: notFound });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
