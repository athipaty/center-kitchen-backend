const mongoose = require("mongoose");
const MarketConversation = require("../../models/market/MarketConversation");
const MarketMessage = require("../../models/market/MarketMessage");
const { verifyMarketToken } = require("../../utils/marketAuth");

// Chat runs on its own namespace so it doesn't share the default namespace's
// global broadcasts with unrelated projects on this shared socket.io server.
function attachMarketChat(io) {
  const marketIo = io.of("/market");

  marketIo.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Missing auth token"));
    try {
      const payload = verifyMarketToken(token);
      socket.data.userId = payload.userId;
      next();
    } catch {
      next(new Error("Invalid or expired token"));
    }
  });

  marketIo.on("connection", (socket) => {
    const userId = socket.data.userId;

    // Every listener below runs as an async function, but socket.io does not
    // await listeners or catch their rejections — an uncaught rejection here
    // becomes an unhandled promise rejection that crashes the whole shared
    // backend process (verified: an "undefined" conversationId did exactly
    // this). Every handler is wrapped so a bad request only errors that
    // socket, never the process.

    socket.on("join", async (conversationId) => {
      try {
        if (!mongoose.isValidObjectId(conversationId)) {
          socket.emit("error", { error: "Invalid conversation id" });
          return;
        }
        const conversation = await MarketConversation.findById(conversationId);
        if (!conversation || (String(conversation.buyer) !== userId && String(conversation.seller) !== userId)) {
          socket.emit("error", { error: "Not part of this conversation" });
          return;
        }
        socket.join(conversationId);
      } catch (err) {
        socket.emit("error", { error: err.message });
      }
    });

    socket.on("message", async ({ conversationId, body } = {}) => {
      try {
        const text = body?.trim();
        if (!text || text.length > 2000) {
          socket.emit("error", { error: "Message must be 1-2000 characters" });
          return;
        }
        if (!mongoose.isValidObjectId(conversationId)) {
          socket.emit("error", { error: "Invalid conversation id" });
          return;
        }
        const conversation = await MarketConversation.findById(conversationId);
        if (!conversation || (String(conversation.buyer) !== userId && String(conversation.seller) !== userId)) {
          socket.emit("error", { error: "Not part of this conversation" });
          return;
        }

        const message = await MarketMessage.create({ conversation: conversationId, sender: userId, body: text });

        marketIo.to(conversationId).emit("message", {
          id: message._id,
          conversationId,
          senderId: userId,
          body: message.body,
          createdAt: message.createdAt.toISOString(),
        });
      } catch (err) {
        socket.emit("error", { error: err.message });
      }
    });
  });

  return marketIo;
}

module.exports = { attachMarketChat };
