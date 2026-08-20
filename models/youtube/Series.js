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
    // The single storyteller voice narrating every scene across every episode of this series —
    // replaces per-character voiceName now that one narrator reads the whole episode instead of
    // each character speaking in their own voice. Defaulted from NARRATOR_VOICE_BY_LOCALE at
    // creation time (see routes/youtube/index.js), editable afterward via PATCH /series/:id.
    narratorVoice: { type: String, default: "" },
    // Drives generateScript's word-count target (targetEpisodeMinutes * WORDS_PER_MINUTE, see
    // claudeScript.js) — set once at outline time, applies to every episode in the series.
    targetEpisodeMinutes: { type: Number, default: 5 },
    continuityLog: [continuityEntrySchema],
    status: { type: String, enum: ["active", "archived"], default: "active" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("YoutubeSeries", seriesSchema);
