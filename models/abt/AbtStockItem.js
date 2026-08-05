const mongoose = require('mongoose')

const AbtStockItemSchema = new mongoose.Schema({
  code:      { type: Number, required: true },
  name:      { type: String, required: true },
  unit:      { type: String, default: '' },
  unitPrice: { type: Number, default: 0 },
  balance:   { type: Number, default: 0 },
  category:  { type: String, default: 'วัสดุไฟฟ้า' },
  note:      { type: String, default: '' },
  isActive:  { type: Boolean, default: true },
}, { timestamps: true })

module.exports = mongoose.model('AbtStockItem', AbtStockItemSchema)
