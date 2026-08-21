const mongoose = require("mongoose");

const playerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 20,
    },
    x: {
      type: Number,
      default: 400,
    },
    y: {
      type: Number,
      default: 300,
    },
    inventory: {
      wood: { type: Number, default: 0 },
      stone: { type: Number, default: 0 },
      ore: { type: Number, default: 0 },
    },
    upgrades: {
      axeLevel: { type: Number, default: 0 },
      pickaxeLevel: { type: Number, default: 0 },
      bootsLevel: { type: Number, default: 0 },
      bagLevel: { type: Number, default: 0 },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("CraftAdventurePlayer", playerSchema);
