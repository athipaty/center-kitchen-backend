// routes/chat.js
const express = require("express");
const ChatRoom = require("../models/ChatRoom");
const Message = require("../models/Message");

const router = express.Router();

/* Get or create room */
router.get("/room/:outletId", async (req, res) => {
  const { outletId } = req.params;
  const { outletName } = req.query;

  let room = await ChatRoom.findOne({ outletId });

  if (!room) {
    room = await ChatRoom.create({
      outletId,
      outletName,
    });
  }

  res.json(room);
});

router.get("/messages/:roomId", async (req, res) => {
  const { roomId } = req.params; // ✅ FIX: you forgot this before

  const messages = await Message.find({ roomId })
    .sort({ createdAt: 1 })
    .limit(200);

  res.json(messages);
});

router.post("/messages", async (req, res) => {
  const { roomId, senderType, senderName, text } = req.body;

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

  // ✅ SOCKET BROADCAST
  const io = req.app.get("io");
  if (io) {
    io.to(roomId).emit("newMessage", message);
  }

  res.json(message);
});

module.exports = router;
