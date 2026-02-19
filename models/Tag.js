const mongoose = require("mongoose");

const TagSchema = new mongoose.Schema({
  tagNo: { type: String, unique: true }
});

module.exports = mongoose.model("Tag", TagSchema);
