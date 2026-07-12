const mongoose = require("mongoose");

// One entry per finished episode — the whole mechanism that keeps a multi-episode story
// consistent without any special animation tech. Every new episode's script prompt is fed
// this log so it remembers what already happened instead of drifting or contradicting itself.
const continuityEntrySchema = new mongoose.Schema(
  {
    episodeNumber: { type: Number, required: true },
    summary: { type: String, required: true },
  },
  { timestamps: true }
);

const seriesSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    premise: { type: String, required: true }, // one-paragraph pitch fed into every script-gen prompt
    genre: { type: String, default: "" },
    tone: { type: String, default: "" }, // e.g. "lighthearted adventure, witty banter"
    // Shared visual-style suffix appended to every image prompt (characters AND backgrounds)
    // so the whole series looks like one consistent art style, not a new style per generation.
    artStyle: { type: String, default: "" },
    voiceLocale: { type: String, default: "en-US" },
    continuityLog: [continuityEntrySchema],
    status: { type: String, enum: ["active", "archived"], default: "active" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("YoutubeSeries", seriesSchema);
