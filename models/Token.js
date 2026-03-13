const mongoose = require("mongoose");

const TokenSchema = new mongoose.Schema({
  token:  { type: String, required: true, unique: true },
  ip:     String,
  expiry: Number,
}, { timestamps: true });

module.exports = mongoose.model("Token", TokenSchema);