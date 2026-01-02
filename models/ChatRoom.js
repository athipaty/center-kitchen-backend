// models/ChatRoom.js
const mongoose = require("mongoose");

const chatRoomSchema = new mongoose.Schema(
  {
    outletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Outlet",
      required: true,
      unique: true,
    },
    outletName: {
      type: String,
      required: true,
    },
    lastMessage: String,
    lastMessageAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model("ChatRoom", chatRoomSchema);
