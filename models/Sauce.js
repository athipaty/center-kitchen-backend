const mongoose = require("mongoose");

const SauceSchema = new mongoose.Schema({
  sauceName: {
    type: String,
    required: true,
  },
  standardWeightKg: {
    type: Number,
    required: true,
  },

  // ✅ NEW (correct way)
  outletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Outlet",
    required: true,
  },

  // ⚠️ KEEP FOR NOW (do NOT delete yet)
  outletName: {
    type: String,
  },
});

module.exports = mongoose.model("Sauce", SauceSchema);
