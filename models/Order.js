// models/Order.js
const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  outletName: { type: String, required: true },
  sauce: { type: String, required: true },
  quantity: { type: Number, required: true },
  deliveryDate: { type: String, required: true },
  status: { type: String, default: 'pending' } // 👈 NEW: 'pending' or 'delivered'
});

module.exports = mongoose.model('Order', orderSchema);
