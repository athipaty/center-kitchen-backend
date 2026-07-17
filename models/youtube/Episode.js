const mongoose = require("mongoose");

const dialogueLineSchema = new mongoose.Schema(
  {
    character: { type: mongoose.Schema.Types.ObjectId, ref: "YoutubeCharacter", default: null }, // null = narrator
    expression: { type: String, default: "neutral" }, // which sprite to show while this line plays
    text: { type: String, required: true },
    audioUrl: { type: String, default: null }, // B2 URL, filled during the 'tts' step
    durationMs: { type: Number, default: null }, // filled during the 'tts' step, drives scene timing
  },
  { timestamps: false }
);

const sceneSchema = new mongoose.Schema(
  {
    order: { type: Number, required: true },
    backgroundPrompt: { type: String, required: true }, // text prompt sent to the image generator
    backgroundUrl: { type: String, default: null }, // B2 URL, filled during the 'backgrounds' step
    cameraMove: {
      type: String,
      enum: ["pan-left", "pan-right", "zoom-in", "zoom-out", "static"],
      default: "zoom-in",
    },
    charactersOnScreen: [{ type: mongoose.Schema.Types.ObjectId, ref: "YoutubeCharacter" }],
    dialogue: [dialogueLineSchema],
  },
  { timestamps: false }
);

const episodeSchema = new mongoose.Schema(
  {
    series: { type: mongoose.Schema.Types.ObjectId, ref: "YoutubeSeries", required: true, index: true },
    episodeNumber: { type: Number, required: true },
    premise: { type: String, required: true }, // the one-line prompt that kicked off this episode
    title: { type: String, default: "" }, // filled in by Claude during the 'script' step
    scenes: [sceneSchema],
    // Drives the render job pipeline (jobs/youtubeEpisodeScheduler.js) — each status is one
    // completed pipeline step; the scheduler picks up anything not in ['done','error'] and
    // advances it to the next status. See that file for exactly what each step does.
    status: {
      type: String,
      enum: ["pending", "script", "sprites", "backgrounds", "tts", "review", "rendering", "uploading", "publishing", "done", "error"],
      default: "pending",
      index: true,
    },
    statusDetail: { type: String, default: "" }, // human-readable sub-step, e.g. "background 2/4"
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
