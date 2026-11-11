const mongoose = require("mongoose");

// One Embervale player account and its saved character.
// Stored in its own "ember_accounts" collection so it never mixes with other projects' data.
const emberAccountSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    // The game's own save format ({ v: 1, p: {...} }), written by the client.
    // Validated for shape and size in routes/embervale/index.js.
    character: { type: mongoose.Schema.Types.Mixed, default: null },
    characterSavedAt: { type: Date, default: null },
    // moderation (routes/embervale/mod.js): no chat until mutedUntil, no live play until bannedUntil
    mutedUntil: { type: Date, default: null },
    bannedUntil: { type: Date, default: null },
    banReason: { type: String, default: "" },
    // ranked arena (routes/embervale/arena.js): { r: rating, w, l, d, name: last character name }
    arena: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model("EmberAccount", emberAccountSchema, "ember_accounts");
