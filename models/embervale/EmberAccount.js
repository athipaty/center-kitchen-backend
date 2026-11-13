const mongoose = require("mongoose");

// One Embervale player account, its three character slots and its shared storage.
// Stored in its own "ember_accounts" collection so it never mixes with other projects' data.
const emberAccountSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    // The game's own save format ({ v: 1, p: {...} }), written by the client.
    // Validated for shape and size in routes/embervale/index.js.
    character: { type: mongoose.Schema.Types.Mixed, default: null },
    characterSavedAt: { type: Date, default: null },
    // character slots 2 and 3 (?slot=1 / ?slot=2 in routes/embervale/index.js); slot 1 is "character" above
    character1: { type: mongoose.Schema.Types.Mixed, default: null },
    character1SavedAt: { type: Date, default: null },
    character2: { type: mongoose.Schema.Types.Mixed, default: null },
    character2SavedAt: { type: Date, default: null },
    // storage shared by every character on the account (an array of item entries); null until first used.
    // storageRev goes up on every change so two devices cannot both take the same item.
    storage: { type: mongoose.Schema.Types.Mixed, default: null },
    storageRev: { type: Number, default: 0 },
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
