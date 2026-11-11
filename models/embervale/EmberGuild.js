const mongoose = require("mongoose");

// One Embervale guild. Members are accounts (by username); guests cannot join.
// Stored in its own "ember_guilds" collection so it never mixes with other projects' data.
const memberSchema = new mongoose.Schema(
  {
    u: { type: String, required: true },          // account username
    c: { type: String, default: "" },             // character name last seen
    rank: { type: String, enum: ["leader", "officer", "member"], default: "member" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const emberGuildSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    key: { type: String, required: true, unique: true }, // lowercased name, for uniqueness
    emblem: { type: [Number], default: [0, 0, 0] },      // [shape, colour, background] indexes
    notice: { type: String, default: "" },
    members: { type: [memberSchema], default: [] },
  },
  { timestamps: true }
);
emberGuildSchema.index({ "members.u": 1 });

module.exports = mongoose.model("EmberGuild", emberGuildSchema, "ember_guilds");
