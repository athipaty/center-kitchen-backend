const mongoose = require("mongoose");

// A player's report about another player, for the Embervale admins to review.
// Kept in its own "ember_reports" collection.
const emberReportSchema = new mongoose.Schema(
  {
    reporter: { type: String, default: null },      // account username, or null for a guest
    reporterName: { type: String, required: true }, // character name
    target: { type: String, required: true },       // character name
    targetAccount: { type: String, default: null }, // account username, or null for a guest
    reason: { type: String, enum: ["spam", "abuse", "cheating", "name", "other"], default: "other" },
    note: { type: String, default: "" },
    // the reported player's last lines (said aloud, party, guild, and whispers to the reporter) as evidence
    chat: { type: [{ _id: false, t: Date, kind: String, text: String }], default: [] },
    room: { type: String, default: "" },
    zone: { type: String, default: "" },
    status: { type: String, enum: ["open", "done"], default: "open" },
    handledBy: { type: String, default: null },
    action: { type: String, default: null },
  },
  { timestamps: true }
);
emberReportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("EmberReport", emberReportSchema, "ember_reports");
