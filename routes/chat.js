// routes/chat.js
const express = require("express");
const ChatRoom = require("../models/ChatRoom");
const Message = require("../models/Message");

const router = express.Router();

/* =========================
   GET or CREATE CHAT ROOM
========================= */
router.get("/room/:outletId", async (req, res) => {
  try {
    const { outletId } = req.params;
    const { outletName = "Unknown Outlet" } = req.query;

    if (!outletId) {
      return res.status(400).json({ message: "outletId is required" });
    }

    let room = await ChatRoom.findOne({ outletId });

    if (!room) {
      room = await ChatRoom.create({
        outletId,
        outletName,
      });
    }

    res.json(room);
  } catch (err) {
    console.error("Chat room error:", err);
    res.status(500).json({ message: "Failed to get chat room" });
  }
});

/* =========================
   GET MESSAGES
========================= */
router.get("/messages/:roomId", async (req, res) => {
  try {
    const { roomId } = req.params;

    if (!roomId) {
      return res.status(400).json({ message: "roomId is required" });
    }

    const messages = await Message.find({ roomId })
      .sort({ createdAt: 1 })
      .limit(200);

    res.json(messages);
  } catch (err) {
    console.error("Get messages error:", err);
    res.status(500).json({ message: "Failed to load messages" });
  }
});

/* =========================
   SEND MESSAGE
========================= */
router.post("/messages", async (req, res) => {
  try {
    const { roomId, senderType, senderName, text } = req.body;

    if (!roomId || !senderType || !text) {
      return res.status(400).json({
        message: "roomId, senderType and text are required",
      });
    }

    if (!["outlet", "center"].includes(senderType)) {
      return res.status(400).json({
        message: "Invalid senderType",
      });
    }

    const message = await Message.create({
      roomId,
      senderType,
      senderName,
      text,
    });

    await ChatRoom.findByIdAndUpdate(roomId, {
      lastMessage: text,
      lastMessageAt: new Date(),
    });

    res.json(message);
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ message: "Failed to send message" });
  }
});

module.exports = router;
