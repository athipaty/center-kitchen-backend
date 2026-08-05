const mongoose = require('mongoose')

const AbtStockTransactionSchema = new mongoose.Schema({
  item:         { type: mongoose.Schema.Types.ObjectId, ref: 'AbtStockItem', required: true },
  itemCode:     { type: Number, default: null },
  itemName:     { type: String, required: true },
  type:         { type: String, enum: ['รับ', 'จ่าย'], required: true },
  date:         { type: Date, default: Date.now },
  party:        { type: String, default: '' }, // รับจาก / จ่ายให้
  docNo:        { type: String, default: '' },
  qty:          { type: Number, required: true },
  unit:         { type: String, default: '' },
  unitPrice:    { type: Number, default: 0 },
  amount:       { type: Number, default: 0 },
  balanceAfter: { type: Number, default: 0 },
  note:         { type: String, default: '' },
}, { timestamps: true })

module.exports = mongoose.model('AbtStockTransaction', AbtStockTransactionSchema)
