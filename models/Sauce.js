// models/Sauce.js
const mongoose = require('mongoose');

const sauceSchema = new mongoose.Schema(// models/Sauce.js
{
  outletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Outlet",
    required: true
  },
  sauceName: String,
  standardWeightKg: Number
}
);

module.exports = mongoose.model('Sauce', sauceSchema);
