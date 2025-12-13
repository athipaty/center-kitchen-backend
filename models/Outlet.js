// models/Outlet.js
const mongoose = require('mongoose');

const outletSchema = new mongoose.Schema({
  name: { type: String, required: true }
});

module.exports = mongoose.model('Outlet', outletSchema);
