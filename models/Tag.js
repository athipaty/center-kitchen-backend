const mongoose = require("mongoose");

const TagSchema = new mongoose.Schema({
  tagNo: { type: String,}
});

module.exports = mongoose.model("Tag", TagSchema);
