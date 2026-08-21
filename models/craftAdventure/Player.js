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
    // Center of the game world (WORLD_W x WORLD_H = 2400 x 1600 in game.js).
    x: {
      type: Number,
      default: 1200,
    },
    y: {
      type: Number,
      default: 800,
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
    // Player-placed buildings (walls, etc.) — world position, no per-item
    // state. Each gets an auto _id so a single structure can be targeted for
    // demolition without relying on (collidable, so unique-ish) position.
    structures: [
      {
        type: { type: String, required: true },
        x: { type: Number, required: true },
        y: { type: Number, required: true },
      },
    ],
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("CraftAdventurePlayer", playerSchema);
