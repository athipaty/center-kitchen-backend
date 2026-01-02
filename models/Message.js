// models/Message.js
const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    roomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatRoom",
      required: true,
    },
    senderType: {
      type: String,
      enum: ["outlet", "center"],
      required: true,
    },
    senderName: String,
    text: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", messageSchema);
