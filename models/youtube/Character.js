const mongoose = require("mongoose");

// A single locked pose/expression image, generated once and reused forever. Character
// consistency across an entire series comes ENTIRELY from reusing these exact images in every
// scene instead of re-generating the character fresh each time (which AI image models can't do
// reliably) — see the "why" comment on Character.description below.
const spriteSchema = new mongoose.Schema(
  {
    expression: { type: String, required: true }, // 'neutral' | 'happy' | 'sad' | 'surprised' | 'angry'
    imageUrl: { type: String, required: true }, // B2 public URL
    seed: { type: Number, default: null },
  },
  { timestamps: true }
);

const characterSchema = new mongoose.Schema(
  {
    series: { type: mongoose.Schema.Types.ObjectId, ref: "YoutubeSeries", required: true, index: true },
    name: { type: String, required: true },
    // The locked visual description — reused verbatim in every sprite-generation prompt. This
    // text IS the character's identity as far as the image model is concerned; changing it after
    // sprites already exist would make new sprites (if ever regenerated) look like someone else.
    description: { type: String, required: true },
    voiceName: { type: String, required: true }, // exact edge-tts voice id, e.g. 'en-US-GuyNeural'
    sprites: [spriteSchema], // 5-8 expressions, generated once during the 'sprites' pipeline step
    status: { type: String, enum: ["pending", "generating_sprites", "ready", "error"], default: "pending" },
    spriteError: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("YoutubeCharacter", characterSchema);
