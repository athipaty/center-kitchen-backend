const mongoose = require("mongoose");

const LocationSchema = new mongoose.Schema({
  location: { type: String},
});

module.exports = mongoose.model("Location", LocationSchema);