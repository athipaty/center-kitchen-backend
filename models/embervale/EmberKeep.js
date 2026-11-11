const mongoose = require("mongoose");

// Who owns Emberkeep (the guild-war territory) in each game room, won in the last guild war.
// Stored in its own "ember_keeps" collection.
const emberKeepSchema = new mongoose.Schema(
  {
    room: { type: String, required: true, unique: true },
    guildId: { type: String, default: null },
    name: { type: String, default: "" },
    emblem: { type: [Number], default: [0, 0, 0] },
    points: { type: Number, default: 0 },
    since: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmberKeep", emberKeepSchema, "ember_keeps");
