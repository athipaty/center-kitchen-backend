const mongoose = require('mongoose')

const AbtStockItemSchema = new mongoose.Schema({
  code:      { type: Number, required: true },
  name:      { type: String, required: true },
  unit:      { type: String, default: '' },
  unitPrice: { type: Number, default: 0 },
  balance:   { type: Number, default: 0 },
  // ยอดยกมา — balance carried in before this item's earliest recorded transaction. Left
  // null until an admin explicitly sets it; the frontend derives a display value from the
  // oldest transaction's balanceAfter until then.
  openingBalance: { type: Number, default: null },
  category:  { type: String, default: 'วัสดุไฟฟ้า' },
  note:      { type: String, default: '' },
  isActive:  { type: Boolean, default: true },
}, { timestamps: true })

module.exports = mongoose.model('AbtStockItem', AbtStockItemSchema)
