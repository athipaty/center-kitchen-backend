const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const MarketConversation = require("../../models/market/MarketConversation");
const MarketListing = require("../../models/market/MarketListing");
const MarketMessage = require("../../models/market/MarketMessage");
const { requireMarketAuth } = require("../../utils/marketAuth");

function toClientMessage(message) {
  const obj = message.toObject ? message.toObject() : message;
  return {
    id: obj._id,
    conversationId: obj.conversation,
    senderId: obj.sender,
    body: obj.body,
    createdAt: obj.createdAt,
    readAt: obj.readAt,
  };
}

function toClientConversation(conversation) {
  const obj = conversation.toObject ? conversation.toObject() : conversation;
  return {
    id: obj._id,
    listingId: obj.listing,
    buyerId: obj.buyer,
    sellerId: obj.seller,
    createdAt: obj.createdAt,
  };
}

// Start (or resume) a conversation with a listing's seller, sending the first message.
router.post("/", requireMarketAuth, async (req, res) => {
  try {
    const { listingId, message } = req.body;
    if (!listingId || !message) {
      return res.status(400).json({ error: "listingId and message are required" });
    }
    if (!mongoose.isValidObjectId(listingId)) return res.status(404).json({ error: "Listing not found" });
    const buyerId = req.marketAuth.userId;

    const listing = await MarketListing.findById(listingId);
    if (!listing) return res.status(404).json({ error: "Listing not found" });
    if (String(listing.seller) === buyerId) {
      return res.status(400).json({ error: "You cannot message yourself about your own listing" });
    }

    let conversation = await MarketConversation.findOne({ listing: listingId, buyer: buyerId });
    if (!conversation) {
      conversation = await MarketConversation.create({
        listing: listingId,
        buyer: buyerId,
        seller: listing.seller,
      });
    }

    const created = await MarketMessage.create({ conversation: conversation._id, sender: buyerId, body: message });
    res.status(201).json({ conversation: toClientConversation(conversation), message: toClientMessage(created) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List conversations the current user is part of.
router.get("/", requireMarketAuth, async (req, res) => {
  try {
    const userId = req.marketAuth.userId;
    const conversations = await MarketConversation.find({ $or: [{ buyer: userId }, { seller: userId }] })
      .populate("listing", "title images price")
      .populate("buyer", "name")
      .populate("seller", "name")
      .sort({ createdAt: -1 })
      .lean();

    const withLastMessage = await Promise.all(
      conversations.map(async (c) => {
        const last = await MarketMessage.findOne({ conversation: c._id }).sort({ createdAt: -1 });
        return {
          id: c._id,
          listingId: c.listing?._id,
          buyerId: c.buyer?._id,
          sellerId: c.seller?._id,
          createdAt: c.createdAt,
          listing: c.listing,
          buyer: c.buyer,
          seller: c.seller,
          messages: last ? [toClientMessage(last)] : [],
        };
      })
    );

    res.json({ conversations: withLastMessage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function loadConversationForUser(conversationId, userId) {
  if (!mongoose.isValidObjectId(conversationId)) return { error: 404 };
  const conversation = await MarketConversation.findById(conversationId);
  if (!conversation) return { error: 404 };
  if (String(conversation.buyer) !== userId && String(conversation.seller) !== userId) {
    return { error: 403 };
  }
  return { conversation };
}

router.get("/:id/messages", requireMarketAuth, async (req, res) => {
  try {
    const result = await loadConversationForUser(req.params.id, req.marketAuth.userId);
    if (result.error === 404) return res.status(404).json({ error: "Conversation not found" });
    if (result.error === 403) return res.status(403).json({ error: "Not part of this conversation" });

    const messages = await MarketMessage.find({ conversation: req.params.id }).sort({ createdAt: 1 });
    res.json({ conversation: toClientConversation(result.conversation), messages: messages.map(toClientMessage) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/messages", requireMarketAuth, async (req, res) => {
  try {
    const result = await loadConversationForUser(req.params.id, req.marketAuth.userId);
    if (result.error === 404) return res.status(404).json({ error: "Conversation not found" });
    if (result.error === 403) return res.status(403).json({ error: "Not part of this conversation" });

    const { body } = req.body;
    if (!body) return res.status(400).json({ error: "body is required" });

    const message = await MarketMessage.create({
      conversation: req.params.id,
      sender: req.marketAuth.userId,
      body,
    });
    res.status(201).json({ message: toClientMessage(message) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
