// models/Sauce.js
const mongoose = require('mongoose');

const sauceSchema = new mongoose.Schema({
  outletName: { type: String, required: true },  // related to Outlet
  sauceName: { type: String, required: true },
  standardWeightKg: { type: Number, required: true }
});

module.exports = mongoose.model('Sauce', sauceSchema);
