const mongoose = require("mongoose");

// One storyteller-voiced beat of narration within a scene — no `character` ref: the whole episode
// is read by the series' single narratorVoice now, so there's no per-line speaker to attribute a
// line to (see Series.narratorVoice). Kept as an array of short segments rather than one big string
// per scene purely for TTS/render pacing — each segment gets its own edge-tts call and its own
// audioUrl/durationMs, which is what drives that scene's on-screen timing in Remotion.
const narrationLineSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    audioUrl: { type: String, default: null }, // B2 URL, filled during the 'tts' step
    durationMs: { type: Number, default: null }, // filled during the 'tts' step, drives scene timing
  },
  { timestamps: false }
);

// A short spoken hook read before scene 1 - written by Claude alongside the script (see
// generateScript in claudeScript.js), synthesized during the 'tts' step just like any narration
// line. Rendered over scene 1's own image as a title card (see EpisodeComposition.tsx's IntroCard)
// rather than generating a separate image for it, so it costs nothing extra to add.
const introSchema = new mongoose.Schema(
  {
    text: { type: String, default: "" },
    audioUrl: { type: String, default: null }, // B2 URL, filled during the 'tts' step
    durationMs: { type: Number, default: null }, // filled during the 'tts' step, drives title card timing
  },
  { timestamps: false, _id: false }
);

const sceneSchema = new mongoose.Schema(
  {
    order: { type: Number, required: true },
    backgroundPrompt: { type: String, required: true }, // text prompt sent to the image generator
    // A scene renders as one full-frame illustration — the setting and every on-screen character's
    // locked description baked into a single prompt for consistency. Filled during the 'images'
    // step (jobs/youtubeEpisodeScheduler.js).
    imageUrl: { type: String, default: null },
    charactersOnScreen: [{ type: mongoose.Schema.Types.ObjectId, ref: "YoutubeCharacter" }],
    narration: [narrationLineSchema],
  },
  { timestamps: false }
);

const episodeSchema = new mongoose.Schema(
  {
    series: { type: mongoose.Schema.Types.ObjectId, ref: "YoutubeSeries", required: true, index: true },
    episodeNumber: { type: Number, required: true },
    premise: { type: String, required: true }, // the one-line prompt that kicked off this episode
    title: { type: String, default: "" }, // filled in by Claude during the 'script' step
    intro: { type: introSchema, default: () => ({}) },
    scenes: [sceneSchema],
    // Drives the render job pipeline (jobs/youtubeEpisodeScheduler.js) — each status is one
    // completed pipeline step; the scheduler picks up anything not in ['done','error'] and
    // advances it to the next status. See that file for exactly what each step does.
    status: {
      type: String,
      enum: ["pending", "script", "images", "tts", "review", "rendering", "rendered", "uploading", "publishing", "done", "error"],
      default: "pending",
      index: true,
    },
    statusDetail: { type: String, default: "" }, // human-readable sub-step, e.g. "spread 2/4"
    errorMessage: { type: String, default: null },
    videoUrl: { type: String, default: null }, // final B2 MP4 URL
    youtubeVideoId: { type: String, default: null }, // filled during the 'uploading' step
    youtubeUrl: { type: String, default: null },
    durationMs: { type: Number, default: null },
  },
  { timestamps: true }
);

episodeSchema.index({ series: 1, episodeNumber: 1 }, { unique: true });

module.exports = mongoose.model("YoutubeEpisode", episodeSchema);
