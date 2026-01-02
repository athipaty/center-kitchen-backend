// models/Message.js
const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true },

    senderType: { type: String, required: true }, // "center" | "outlet"
    senderName: { type: String, required: true }, // display name
    senderId: { type: String, required: true },   // stable identity (e.g. "center" or "outlet:<id>")

    text: { type: String, required: true },

    // ✅ Read receipts: map of userId -> Date
    readBy: { type: Object, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", MessageSchema);
