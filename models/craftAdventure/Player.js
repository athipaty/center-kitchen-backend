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
      knightLevel: { type: Number, default: 0 },
    },
    // Player-placed buildings (walls, etc.) — world position plus upgrade
    // level. Each gets an auto _id so a single structure can be targeted for
    // demolition, moving, or upgrading without relying on (collidable, so
    // unique-ish) position.
    structures: [
      {
        type: { type: String, required: true },
        x: { type: Number, required: true },
        y: { type: Number, required: true },
        level: { type: Number, default: 1 },
      },
    ],
    // Fog-of-war reveal state: one bit per map cell (FOG_COLS x FOG_ROWS in
    // game.js), packed and base64-encoded client-side so a login restores
    // the areas already explored instead of everything starting fogged
    // again. Opaque to the server — just stored and echoed back as-is.
    exploredCells: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("CraftAdventurePlayer", playerSchema);
