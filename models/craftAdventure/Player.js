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
    // Current HP (out of PLAYER_MAX_HEALTH in game.js) — so logging back
    // in doesn't hand you back a full health bar after taking damage.
    health: {
      type: Number,
      default: 30,
    },
    // Snapshot of every resource node's current state (position, amount
    // left, respawn timer) — the client's initial layout is otherwise
    // reproducible from a per-name seed, but depleted/relocated nodes
    // aren't, so this is what makes a login pick up gathering progress
    // instead of handing back a full, undepleted map. Empty means "no
    // snapshot yet, seed a fresh layout" (a brand-new player, or right
    // after a reset). Untyped array — the server never reads into these,
    // just stores/echoes them back for the client to restore verbatim.
    resources: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("CraftAdventurePlayer", playerSchema);
