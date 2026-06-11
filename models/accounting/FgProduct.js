const mongoose = require('mongoose');

const fgProductSchema = new mongoose.Schema({
  code:           { type: String, required: true },
  name:           { type: String, required: true },
  openingBalance: { type: Number, default: 0 },
  received:       { type: Number, default: 0 },
  issued:         { type: Number, default: 0 },
  balance:        { type: Number, default: 0 },
  rmCost:         { type: Number, default: 0 },
  dmCost:         { type: Number, default: 0 },
  ohCost:         { type: Number, default: 0 },
  pkCost:         { type: Number, default: 0 },
  totalCost:      { type: Number, default: 0 },
  unitCost:       { type: Number, default: 0 },
  month:          { type: Number, required: true },
  year:           { type: Number, required: true },
  company:        { type: String, default: 'Express' },
  materials: [{
    materialCode: String,
    materialName: String,
    quantity:     Number,
    unitCost:     Number,
    totalCost:    Number,
  }],
}, { timestamps: true });

fgProductSchema.index({ company: 1, code: 1, month: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('FgProduct', fgProductSchema);
