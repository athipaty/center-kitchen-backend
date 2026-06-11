const mongoose = require('mongoose');

const rawMaterialSchema = new mongoose.Schema({
  code:           { type: String, required: true },
  name:           { type: String, required: true },
  unit:           { type: String, default: 'KGM' },
  openingBalance: { type: Number, default: 0 },
  received:       { type: Number, default: 0 },
  issued:         { type: Number, default: 0 },
  balance:        { type: Number, default: 0 },
  latestCost:     { type: Number, default: 0 },
  avgCost:        { type: Number, default: 0 },
  totalValue:     { type: Number, default: 0 },
  month:          { type: Number, required: true },
  year:           { type: Number, required: true },
  company:        { type: String, default: 'Express' },
}, { timestamps: true });

rawMaterialSchema.index({ company: 1, code: 1, month: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('RawMaterial', rawMaterialSchema);
