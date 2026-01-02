// models/Message.js
const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },

    senderType: { type: String, enum: ["center", "outlet"], required: true },
    senderName: { type: String, required: true },
    senderId: { type: String, required: true, index: true },

    text: { type: String, default: "" },

    // ✅ read receipts (you already use readBy)
    readBy: { type: Object, default: {} }, // { userId: ISODateString }

    // ✅ WhatsApp-style
    editedAt: { type: Date, default: null },

    // delete for everyone
    deletedForAll: { type: Boolean, default: false },

    // delete for me (list of userIds)
    deletedFor: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", MessageSchema);
