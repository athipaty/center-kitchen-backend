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

/* Get messages */
router.get("/messages/:roomId", async (req, res) => {
  const { roomId } = req.params;

  const messages = await Message.find({ roomId })
    .sort({ createdAt: 1 })
    .limit(200);

  res.json(messages);
});

/* Post message */
router.post("/messages", async (req, res) => {
  const { roomId, senderType, senderName, senderId, text } = req.body;

  if (!roomId || !text || !senderType || !senderName || !senderId) {
    return res.status(400).json({ message: "Missing fields" });
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

  // ✅ SOCKET BROADCAST
  const io = req.app.get("io");
  if (io) {
    io.to(roomId).emit("newMessage", message);
  }

  // ✅ PUSH NOTIFICATION (real web push)
  // Send push to subscribers in this room EXCEPT senderId
  try {
    const PushSubscription = require("../models/PushSubscription");
    const webpush = require("web-push");

    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT;

    if (publicKey && privateKey && subject) {
      webpush.setVapidDetails(subject, publicKey, privateKey);

      const subs = await PushSubscription.find({
        roomId,
        userId: { $ne: senderId },
      });

      // Optional: avoid push if user is online in room
      const isUserOnlineInRoom = req.app.get("isUserOnlineInRoom");

      const payload = JSON.stringify({
        title: `Chat – ${senderName}`,
        body: text,
        roomId,
      });

      await Promise.all(
        subs.map(async (s) => {
          if (isUserOnlineInRoom && isUserOnlineInRoom(roomId, s.userId)) {
            return; // skip push if actively online
          }
          try {
            await webpush.sendNotification(s.subscription, payload);
          } catch (err) {
            // If subscription is invalid, remove it
            if (err.statusCode === 404 || err.statusCode === 410) {
              await PushSubscription.deleteOne({ _id: s._id });
            }
          }
        })
      );
    }
  } catch (err) {
    console.error("Push send error:", err.message || err);
  }

  res.json(message);
});

module.exports = router;
