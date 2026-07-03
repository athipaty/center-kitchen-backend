const express = require("express");
const router = express.Router();
const axios = require("axios");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

const Order = require("../../models/tracker/Order");
const Product = require("../../models/tracker/Product");
const { getAccessToken, bestVariantMatch } = require("../../jobs/ebayPriceSync");
const { uploadToB2 } = require("../../utils/b2Utils");

function tradingPost(token, callName, body) {
  return axios.post('https://api.ebay.com/ws/api.dll',
    `<?xml version="1.0" encoding="utf-8"?>${body}`,
    {
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml',
      },
    }
  );
}

function escapeXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

// POST upload the delivery photo (e.g. from the courier's "delivered" photo)
router.post("/:id/delivery-photo", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "photo file is required" });
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "order not found" });

    const ext = (req.file.mimetype || 'image/jpeg').split('/')[1] || 'jpg';
    const url = await uploadToB2(req.file.buffer, `delivery-photos/${order._id}.${ext}`, req.file.mimetype);
    order.deliveryPhotoUrl = url;
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST notify the buyer that their item was delivered, with the delivery photo.
// Best-effort: eBay's buyer-messaging surface is legacy (Trading API) and finicky, so on
// failure we still return the composed message text so the UI can offer a manual copy/paste.
router.post("/:id/notify-buyer", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "order not found" });
    if (!order.buyerUserId) return res.status(400).json({ error: "no buyer on this order" });

    const messageText = `Hi! Your package has arrived 📦 ` +
      (order.deliveryPhotoUrl ? `Here's a photo of it delivered: ${order.deliveryPhotoUrl} ` : '') +
      `Thank you so much for your order! If you have a moment, we'd really appreciate your feedback 🙏`;
    order.buyerMessageText = messageText;

    let sent = false;
    try {
      const token = await getAccessToken();
      const creds = `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
      const { data: xml } = await tradingPost(token, 'AddMemberMessageAAQToPartner',
        `<AddMemberMessagesAAQToPartnerRequest xmlns="urn:ebay:apis:eBLBaseComponents">${creds}` +
        `<ItemID>${order.ebayItemId}</ItemID>` +
        `<MemberMessage>` +
        `<Body>${escapeXml(messageText)}</Body>` +
        `<QuestionType>General</QuestionType>` +
        `<RecipientID>${escapeXml(order.buyerUserId)}</RecipientID>` +
        `<DisplayToPublic>false</DisplayToPublic>` +
        `</MemberMessage>` +
        `</AddMemberMessagesAAQToPartnerRequest>`
      );
      sent = !/<Ack>Failure<\/Ack>/.test(xml);
    } catch (e) {
      sent = false;
    }

    order.buyerMessageSent = sent;
    if (sent) order.status = 'notified';
    await order.save();
    res.json({ sent, messageText, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
