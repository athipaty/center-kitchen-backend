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
    // The guided attribute-picker's structured selections (species/age/build/colors/etc.) that
    // composed `description`, so editing a character can reopen the same dropdowns pre-filled
    // instead of just handing back the flattened text. Null for characters created by typing the
    // description manually — the edit form falls back to plain-text editing for those.
    attrs: { type: mongoose.Schema.Types.Mixed, default: null },
    // No longer read by the render pipeline — every episode is now narrated by the series' single
    // narratorVoice instead of each character speaking in their own voice. Left in place (optional,
    // not required) rather than removed so existing character docs don't need a migration; new
    // characters simply don't set it.
    voiceName: { type: String, default: "" },
    voiceOptions: { type: [String], default: [] }, // unused, same reasoning as voiceName above
    // The identity anchor every scene image featuring this character is conditioned on (Gemini
    // 2.5 Flash Image multi-reference generation — see generateSceneWithReferences in
    // utils/youtube/gemini.js). A plain text description alone let the image model reinvent the
    // character's exact look on every scene; this locks it to one actual photo instead. Generated
    // lazily on this character's first use in stepImages, not at character-creation time, so a
    // character that's never actually rendered in a scene never pays for one.
    referenceImageUrl: { type: String, default: null },
    sprites: [spriteSchema], // 5-8 expressions, generated once during the 'sprites' pipeline step
    status: { type: String, enum: ["pending", "generating_sprites", "ready", "error"], default: "pending" },
    spriteError: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("YoutubeCharacter", characterSchema);
