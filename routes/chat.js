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
  try {
    const { roomId } = req.params;

    const messages = await Message.find({ roomId })
      .sort({ createdAt: 1 })
      .limit(200);

    res.json(messages);
  } catch (err) {
    console.error("GET messages error:", err);
    res.status(500).json({ error: "Failed to load messages" });
  }
});

router.post("/messages", async (req, res) => {
  try {
    const { roomId, senderType, senderName, senderId, text } = req.body;

    if (!roomId || !senderType || !senderName || !senderId || !text) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const message = await Message.create({
      roomId,
      senderType,
      senderName,
      senderId,
      text,
    });

    await ChatRoom.findByIdAndUpdate(roomId, {
      lastMessage: text,
      lastMessageAt: new Date(),
    });

    // ✅ SOCKET BROADCAST (existing)
    const io = req.app.get("io");
    if (io) io.to(roomId).emit("newMessage", message);

    res.json(message);
  } catch (err) {
    console.error("POST message error:", err);
    res.status(500).json({ error: "Failed to send" });
  }
});

/* =========================
   ✅ EDIT MESSAGE
   PUT /chat/messages/:messageId
   body: { userId, text }
========================= */
router.put("/messages/:messageId", async (req, res) => {
  try {
    const { messageId } = req.params;
    const { userId, text } = req.body;

    if (!userId || !text) {
      return res.status(400).json({ error: "Missing userId/text" });
    }

    const msg = await Message.findById(messageId);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    // ✅ only sender can edit
    if (msg.senderId !== userId) {
      return res.status(403).json({ error: "Not allowed" });
    }

    // optional: prevent editing deleted-for-all
    if (msg.deletedForAll) {
      return res.status(400).json({ error: "Cannot edit deleted message" });
    }

    msg.text = text;
    msg.editedAt = new Date();
    await msg.save();

    // broadcast update
    const io = req.app.get("io");
    if (io) io.to(msg.roomId).emit("messageUpdated", msg);

    res.json(msg);
  } catch (err) {
    console.error("EDIT message error:", err);
    res.status(500).json({ error: "Failed to edit" });
  }
});

/* =========================
   ✅ DELETE FOR ME
   PATCH /chat/messages/:messageId/delete-for-me
   body: { userId }
========================= */
router.patch("/messages/:messageId/delete-for-me", async (req, res) => {
  try {
    const { messageId } = req.params;
    const { userId } = req.body;

    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const msg = await Message.findById(messageId);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    // add userId to deletedFor (no duplicates)
    if (!msg.deletedFor.includes(userId)) {
      msg.deletedFor.push(userId);
      await msg.save();
    }

    // ⚠️ no broadcast needed (only affects one user)
    res.json({ ok: true, messageId });
  } catch (err) {
    console.error("DELETE FOR ME error:", err);
    res.status(500).json({ error: "Failed to delete-for-me" });
  }
});

/* =========================
   ✅ DELETE FOR EVERYONE
   PATCH /chat/messages/:messageId/delete-for-all
   body: { userId }
========================= */
router.patch("/messages/:messageId/delete-for-all", async (req, res) => {
  try {
    const { messageId } = req.params;
    const { userId } = req.body;

    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const msg = await Message.findById(messageId);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    // ✅ only sender can delete-for-all
    if (msg.senderId !== userId) {
      return res.status(403).json({ error: "Not allowed" });
    }

    msg.deletedForAll = true;
    msg.text = "";
    msg.editedAt = null;
    await msg.save();

    // broadcast update
    const io = req.app.get("io");
    if (io) io.to(msg.roomId).emit("messageUpdated", msg);

    res.json(msg);
  } catch (err) {
    console.error("DELETE FOR ALL error:", err);
    res.status(500).json({ error: "Failed to delete-for-all" });
  }
});

module.exports = router;
