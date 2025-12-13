const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  outletName: { type: String, required: true },
  sauce: { type: String, required: true },
  quantity: { type: Number, required: true },
  deliveryDate: { type: String, required: true }
});

module.exports = mongoose.model('Order', orderSchema);
