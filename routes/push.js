// routes/push.js
const express = require("express");
const PushSubscription = require("../models/PushSubscription");

const router = express.Router();

router.get("/vapidPublicKey", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || "" });
});

router.post("/subscribe", async (req, res) => {
  const { roomId, userId, subscription } = req.body;
  if (!roomId || !userId || !subscription) {
    return res.status(400).json({ message: "Missing fields" });
  }

  // upsert (one subscription per user per room)
  await PushSubscription.findOneAndUpdate(
    { roomId, userId },
    { subscription },
    { upsert: true, new: true }
  );

  res.json({ ok: true });
});

module.exports = router;
