const express = require("express");
const router = express.Router();
const Series = require("../../models/youtube/Series");
const Character = require("../../models/youtube/Character");
const Episode = require("../../models/youtube/Episode");
const scheduler = require("../../jobs/youtubeEpisodeScheduler");
const { deleteB2Prefix } = require("../../utils/b2Utils");
const { generateStoryOutline, suggestStoryIdea } = require("../../utils/youtube/claudeScript");
const { defaultNarratorVoice } = require("../../utils/youtube/narratorVoices");

// ── Story outline (AI-assisted planning) ───────────────────────────
// Suggests a one-line idea to seed the outline wizard's idea box — the "🎲 Suggest an idea"
// button. Stateless and cheap; click again for a different one.
router.post("/outline/idea", async (req, res) => {
  try {
    const { voiceLocale } = req.body;
    const idea = await suggestStoryIdea({ voiceLocale });
    res.json({ idea });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Drafts a whole series (identity + episode breakdown + cast) from a one-line idea before
// anything is persisted, so the user can review/edit the plan in the UI first. Nothing touches
// the DB until POST /outline/commit — abandoning a draft costs nothing.
router.post("/outline", async (req, res) => {
  try {
    const { idea, voiceLocale, targetEpisodeMinutes, episodeCount } = req.body;
    if (!idea || !idea.trim()) return res.status(400).json({ error: "idea is required" });
    const outline = await generateStoryOutline({ idea: idea.trim(), voiceLocale, targetEpisodeMinutes, episodeCount });
    res.json(outline);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Persists a (possibly user-edited) outline: creates the Series, its Characters, and every
// Episode in one shot. Nothing is auto-started — every episode (including #1) sits at "pending"
// until a manual POST /episodes/:id/advance click, same as an episode created one at a time.
router.post("/outline/commit", async (req, res) => {
  try {
    const { title, premise, genre, tone, artStyle, voiceLocale, narratorVoice, targetEpisodeMinutes, episodes, characters } = req.body;
    if (!title || !premise) return res.status(400).json({ error: "title and premise are required" });
    if (!Array.isArray(episodes) || !episodes.length) return res.status(400).json({ error: "at least one episode is required" });
    if (!Array.isArray(characters) || !characters.length) return res.status(400).json({ error: "at least one character is required" });

    const series = await Series.create({
      title, premise, genre, tone, artStyle, voiceLocale, targetEpisodeMinutes,
      narratorVoice: narratorVoice || defaultNarratorVoice(voiceLocale),
    });

    const createdCharacters = await Character.insertMany(
      characters.map((c) => ({ series: series._id, name: c.name, description: c.description }))
    );

    const createdEpisodes = [];
    for (let i = 0; i < episodes.length; i++) {
      const e = episodes[i];
      createdEpisodes.push(await Episode.create({ series: series._id, episodeNumber: i + 1, title: e.title || "", premise: e.premise }));
    }

    res.json({ series, characters: createdCharacters, episodes: createdEpisodes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Series ──────────────────────────────────────────────────────────
router.post("/series", async (req, res) => {
  try {
    const { title, premise, genre, tone, artStyle, voiceLocale, narratorVoice } = req.body;
    if (!title || !premise) return res.status(400).json({ error: "title and premise are required" });
    const series = await Series.create({
      title, premise, genre, tone, artStyle, voiceLocale,
      narratorVoice: narratorVoice || defaultNarratorVoice(voiceLocale || "en-US"),
    });
    res.json(series);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit a series' identity/narrator voice — currently the only field the UI actually lets a user
// change post-creation is narratorVoice (a "New series" form field for everything else already
// exists; this is what a standalone "series settings" affordance would grow into if more fields
// need editing later).
router.patch("/series/:id", async (req, res) => {
  try {
    const { title, premise, genre, tone, artStyle, narratorVoice } = req.body;
    const update = {};
    if (title !== undefined) update.title = title;
    if (premise !== undefined) update.premise = premise;
    if (genre !== undefined) update.genre = genre;
    if (tone !== undefined) update.tone = tone;
    if (artStyle !== undefined) update.artStyle = artStyle;
    if (narratorVoice !== undefined) update.narratorVoice = narratorVoice;
    const series = await Series.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!series) return res.status(404).json({ error: "Series not found" });
    res.json(series);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/series", async (req, res) => {
  try {
    const series = await Series.find().sort({ createdAt: -1 });
    res.json(series);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/series/:id", async (req, res) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series) return res.status(404).json({ error: "Series not found" });
    res.json(series);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a whole series — cascades to every character and episode still under it (same
// mid-pipeline guard as the single-episode delete below: refuses only if the scheduler is
// literally mid-step on one of its episodes right now. Status alone can't tell "safe to delete"
// from "actively being written to" anymore — runDueTick only ever advances the earliest unfinished
// episode per series, so a later sibling can sit at a non-terminal status (e.g. "images")
// indefinitely, genuinely untouched, while waiting behind it. isEpisodeInFlight checks the
// scheduler's real in-memory in-progress set instead of guessing from the stored status.
router.delete("/series/:id", async (req, res) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series) return res.status(404).json({ error: "Series not found" });

    const seriesEpisodes = await Episode.find({ series: series._id }, "_id").lean();
    const inFlight = seriesEpisodes.some((e) => scheduler.isEpisodeInFlight(e._id));
    if (inFlight) {
      return res.status(409).json({ error: "An episode in this series is still being generated — wait for it to finish or error out first." });
    }

    const [characters, episodes] = await Promise.all([
      Character.find({ series: series._id }, "_id").lean(),
      Episode.find({ series: series._id }, "_id").lean(),
    ]);
    await Promise.all([
      ...characters.map((c) => deleteB2Prefix(`youtube/characters/${c._id}/`).catch(() => {})),
      ...episodes.map((e) => deleteB2Prefix(`youtube/episodes/${e._id}/`).catch(() => {})),
    ]);
    await Character.deleteMany({ series: series._id });
    await Episode.deleteMany({ series: series._id });
    await Series.findByIdAndDelete(series._id);

    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Characters ──────────────────────────────────────────────────────
router.post("/characters", async (req, res) => {
  try {
    const { seriesId, name, description, attrs } = req.body;
    if (!seriesId || !name || !description) {
      return res.status(400).json({ error: "seriesId, name, and description are required" });
    }
    const character = await Character.create({
      series: seriesId,
      name,
      description,
      attrs: attrs || null,
    });
    res.json(character);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/characters", async (req, res) => {
  try {
    const { seriesId } = req.query;
    const filter = seriesId ? { series: seriesId } : {};
    const characters = await Character.find(filter).sort({ createdAt: -1 });
    res.json(characters);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit an existing character's name/description/voice/attrs. Sprites already generated are left
// as-is — they're the model's snapshot of whatever description was locked in when they were made,
// so an edit only affects future generate-sprites/regenerate-sprite calls, not existing images.
router.patch("/characters/:id", async (req, res) => {
  try {
    const { name, description, voiceName, voiceOptions, attrs } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (description !== undefined) update.description = description;
    if (voiceName !== undefined) update.voiceName = voiceName;
    if (voiceOptions !== undefined) update.voiceOptions = Array.isArray(voiceOptions) ? voiceOptions : [];
    if (attrs !== undefined) update.attrs = attrs;
    const character = await Character.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!character) return res.status(404).json({ error: "Character not found" });
    res.json(character);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reroll a character's locked reference portrait (the identity anchor every scene image featuring
// them is conditioned on — see Character.referenceImageUrl) without touching anything else about
// the character. Single image, awaited inline like the per-scene regenerate-image route below,
// unlike the multi-image sprite batch further down which needs the 202+socket pattern. Main use
// case: fal.ai's content checker false-flagging a scene that uses this character's photo — a fresh
// generation can dodge the same probabilistic classifier since the actual image bytes change even
// though the character's text description doesn't.
router.post("/characters/:id/regenerate-reference", async (req, res) => {
  try {
    const character = await Character.findById(req.params.id);
    if (!character) return res.status(404).json({ error: "Character not found" });
    await scheduler.regenerateCharacterReferenceImage(character);
    res.json(character);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kicks off sprite generation in the background instead of awaiting it inline — a full 5-sprite
// batch takes 80-150s+ (Pollinations' ~16s sequential rate limit), too long to hold open as a
// single HTTP request without it being fragile to any connection blip (a dev-server restart, a
// phone sleeping, a redeploy) killing an otherwise-successful generation with a bare client-side
// "Network Error". The client gets an immediate ack and follows progress/completion over the
// socket — generateCharacterSprites already emits per-expression progress and always resolves
// (it catches its own errors and persists character.status/spriteError before rethrowing), so the
// .catch() below only needs to cover truly unexpected failures.
router.post("/characters/:id/generate-sprites", async (req, res) => {
  try {
    const character = await Character.findById(req.params.id);
    if (!character) return res.status(404).json({ error: "Character not found" });
    const io = req.app.get("io");
    const characterId = String(character._id);

    scheduler.generateCharacterSprites(character, async (expression) => {
      io?.emit("character:progress", { characterId, expression });
    }).then(() => {
      io?.emit("character:sprites:done", { characterId, character: character.toJSON() });
    }).catch((err) => {
      io?.emit("character:sprites:done", { characterId, error: err.message });
    });

    res.status(202).json({ started: true, character });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Redo a single expression (e.g. only the "sad" sprite came out wrong) without regenerating the
// other four — much faster than the full generate-sprites pass and doesn't disturb sprites
// already approved.
router.post("/characters/:id/regenerate-sprite", async (req, res) => {
  try {
    const { expression } = req.body;
    if (!expression) return res.status(400).json({ error: "expression is required" });
    const character = await Character.findById(req.params.id);
    if (!character) return res.status(404).json({ error: "Character not found" });
    await scheduler.regenerateCharacterSprite(character, expression);
    res.json(character);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generates only the expressions a character doesn't have yet — for when EXPRESSIONS grows
// (e.g. new expressions added on top of an existing 5) and an already-'ready' character needs
// catching up, without regenerating (and losing) the sprites it already has. Same
// background-job-over-socket pattern as generate-sprites, for the same reason (this can take a
// while — several missing expressions at ~16s each).
router.post("/characters/:id/backfill-sprites", async (req, res) => {
  try {
    const character = await Character.findById(req.params.id);
    if (!character) return res.status(404).json({ error: "Character not found" });
    const io = req.app.get("io");
    const characterId = String(character._id);

    scheduler.backfillMissingSprites(character, async (expression) => {
      io?.emit("character:progress", { characterId, expression });
    }).then((missing) => {
      io?.emit("character:sprites:done", { characterId, character: character.toJSON(), backfilled: missing });
    }).catch((err) => {
      io?.emit("character:sprites:done", { characterId, error: err.message });
    });

    res.status(202).json({ started: true, character });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a character. Blocked while it's on-screen in an episode that might still need to look it
// up — stepImages reads a character's description and locked reference photo for its image
// prompts, and editing scenes while paused at "review" (PUT /episodes/:id/scenes) can re-trigger
// that. "rendered" is safe to allow,
// same reasoning as the episode-delete route below: the render already happened, this character's
// art is already baked into the finished MP4, and nothing re-reads the Character doc after that.
router.delete("/characters/:id", async (req, res) => {
  try {
    const inFlight = await Episode.exists({
      "scenes.charactersOnScreen": req.params.id,
      status: { $nin: ["done", "error", "rendered"] },
    });
    if (inFlight) {
      return res.status(409).json({ error: "This character is on screen in an episode that's still rendering — wait for it to finish first." });
    }
    const character = await Character.findByIdAndDelete(req.params.id);
    if (!character) return res.status(404).json({ error: "Character not found" });
    await deleteB2Prefix(`youtube/characters/${character._id}/`).catch(() => {});
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Episodes ────────────────────────────────────────────────────────
// Creates the episode at "pending" only — nothing starts automatically. The first pipeline step
// (script generation) only runs once someone hits POST /episodes/:id/advance below.
router.post("/episodes", async (req, res) => {
  try {
    const { seriesId, premise } = req.body;
    if (!seriesId || !premise) return res.status(400).json({ error: "seriesId and premise are required" });
    const episodeNumber = (await Episode.countDocuments({ series: seriesId })) + 1;
    const episode = await Episode.create({ series: seriesId, episodeNumber, premise });
    res.json(episode);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Runs exactly one pipeline step (script, scene images, or narration — whichever matches the
// episode's current status) and stops, waiting for the next manual click. Mirrors the character
// sprite-generation route below: acks immediately with 202 since a step can take well over a
// minute (image generation especially — 2 Pollinations calls per scene), and the actual
// progress/completion arrives over the 'episode:progress'/'episode:error' sockets already emitted
// by every step.
router.post("/episodes/:id/advance", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (!["pending", "script", "images"].includes(episode.status)) {
      return res.status(409).json({ error: "This episode isn't waiting on a manual step right now." });
    }
    if (scheduler.isEpisodeInFlight(episode._id)) {
      return res.status(409).json({ error: "This step is already running." });
    }
    scheduler.triggerNow(episode._id).catch((e) => console.error("episode triggerNow failed:", e.message));
    res.status(202).json({ started: true, episode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/episodes", async (req, res) => {
  try {
    const { seriesId } = req.query;
    const filter = seriesId ? { series: seriesId } : {};
    // Populated so the episode card can show which characters are on screen without a second
    // round-trip per character.
    const episodes = await Episode.find(filter)
      .sort({ episodeNumber: -1 })
      .populate("scenes.charactersOnScreen", "name sprites");
    res.json(episodes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/episodes/:id", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id).populate("scenes.charactersOnScreen", "name sprites");
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    res.json(episode);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit narration text and/or background prompts at any checkpoint that already has
// scene data to show — "script" (script only), "images" (+ scene art), "review" (+ narration
// audio), or "rendered" (+ finished video, which an edit here does NOT touch; re-approving render
// afterward is what actually replaces it). Only touches what actually changed and re-enters the
// pipeline at the earliest step that needs to redo — reusing the same "already generated, skip it"
// guards stepImages/stepTts use for resuming after a crash, so unrelated scenes/lines are never
// regenerated. "uploading"/"publishing"/"done" stay off-limits: once an episode is live on
// YouTube, edits here wouldn't reach the published video anyway.
const EDITABLE_STATUSES = ["script", "images", "review", "rendered"];
// Position in the pipeline each editable status represents — used below to figure out the
// earliest step an edit needs to re-enter at, without ever jumping the episode FORWARD past
// wherever it already was (e.g. editing narration text while still at "script", before images
// even exist yet, must not skip straight to "images" — there's nothing to regenerate yet, the
// edited text just sits there ready for the images step to eventually hand off to narration).
const STATUS_POSITION = { script: 0, images: 1, review: 2, rendered: 3 };

router.put("/episodes/:id/scenes", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (!EDITABLE_STATUSES.includes(episode.status)) {
      return res.status(409).json({ error: "This episode isn't at a step that can be revised right now." });
    }

    const { scenes: editedScenes = [], intro: editedIntro } = req.body;
    let needsImages = false;
    let needsTts = false;

    if (
      editedIntro && typeof editedIntro.text === "string" &&
      editedIntro.text.trim() !== (episode.intro?.text || "").trim()
    ) {
      episode.intro = { text: editedIntro.text.trim(), audioUrl: null, durationMs: null };
      needsTts = true;
    }

    for (const edited of editedScenes) {
      const scene = episode.scenes.find((s) => s.order === edited.order);
      if (!scene) continue;
      if (typeof edited.backgroundPrompt === "string" && edited.backgroundPrompt.trim() !== scene.backgroundPrompt.trim()) {
        scene.backgroundPrompt = edited.backgroundPrompt.trim();
        scene.imageUrl = null;
        needsImages = true;
      }
      (edited.narration || []).forEach((editedLine, i) => {
        const line = scene.narration[i];
        if (!line) return;
        if (typeof editedLine.text === "string" && editedLine.text.trim() !== line.text.trim()) {
          line.text = editedLine.text.trim();
          line.audioUrl = null;
          line.durationMs = null;
          needsTts = true;
        }
      });
    }

    episode.markModified("scenes");
    // 'script' and 'images' are the same safe re-entry points stepImages/stepTts's "already
    // generated" checks make resumable everywhere else in this pipeline (STEP_HANDLERS.script ->
    // stepImages, STEP_HANDLERS.images -> stepTts). Take the minimum of the current position and
    // whatever an invalidated step requires, so an edit never advances the episode past a step
    // that hasn't actually run yet.
    const currentPos = STATUS_POSITION[episode.status];
    let targetPos = currentPos;
    if (needsImages) targetPos = Math.min(targetPos, STATUS_POSITION.script);
    if (needsTts) targetPos = Math.min(targetPos, STATUS_POSITION.images);
    const targetStatus = Object.keys(STATUS_POSITION).find((k) => STATUS_POSITION[k] === targetPos);
    const willRegenerate = targetStatus !== episode.status;
    episode.status = targetStatus;
    // else: nothing changed, or an edit at "script"/"images" didn't invalidate anything that's
    // actually been generated yet — status stays put, nothing to redo.
    await episode.save();

    if (willRegenerate) {
      scheduler.triggerNow(episode._id).catch((e) => console.error("episode triggerNow failed:", e.message));
    }
    const fresh = await Episode.findById(episode._id).populate("scenes.charactersOnScreen", "name sprites");
    res.json(fresh);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full reset — throws out the current script entirely and asks Claude for a brand-new one from the
// same premise, discarding every scene/image/dialogue/audio that traced back to the old script.
// Unlike PUT /scenes above (which patches specific fields and reuses everything else), this is for
// when the script itself came out wrong in a way editing can't fix (e.g. a character silently
// missing from a scene's charactersOnScreen, so its image never had a chance to include them) —
// there's nothing worth keeping, so it goes all the way back to "pending" for stepScript to redo
// from scratch at the next scheduler tick. Gated by the same EDITABLE_STATUSES as PUT /scenes: not
// once published ("uploading"/"publishing"/"done").
router.post("/episodes/:id/regenerate-script", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (!EDITABLE_STATUSES.includes(episode.status)) {
      return res.status(409).json({ error: "This episode isn't at a step that can be revised right now." });
    }
    episode.scenes = [];
    episode.videoUrl = null;
    episode.status = "pending";
    episode.statusDetail = "";
    await episode.save();
    scheduler.triggerNow(episode._id).catch((e) => console.error("episode triggerNow failed:", e.message));
    const fresh = await Episode.findById(episode._id);
    res.json(fresh);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Redo a scene's image using its already-saved prompt — no text edit required, for when the same
// prompt might come out looking better on a different roll. Allowed anywhere the image already
// exists ("images", "review", "rendered") — not "script" (nothing generated yet) and not once
// published ("uploading"/"publishing"/"done"), same reasoning as EDITABLE_STATUSES above. At
// "rendered" this doesn't change anything already baked into the finished video — re-approving
// render is what actually picks up the new art.
router.post("/episodes/:id/scenes/:order/regenerate-image", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (!["images", "review", "rendered"].includes(episode.status)) {
      return res.status(409).json({ error: "This episode isn't at a step where the image can be regenerated." });
    }
    const order = Number(req.params.order);
    const scene = episode.scenes.find((s) => s.order === order);
    if (!scene) return res.status(404).json({ error: "Scene not found" });

    await scheduler.regenerateSceneImage(episode, scene);
    const fresh = await Episode.findById(episode._id).populate("scenes.charactersOnScreen", "name sprites");
    res.json(fresh);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Redo EVERY scene's image in one go — for when the whole episode's art should be rerolled (e.g.
// after switching art style, or just wanting a fresh take on the whole set) rather than one scene
// at a time via the per-scene endpoint above. Keeps the script and each character's locked
// referenceImageUrl untouched (identity stays consistent) — only the scene compositions reroll.
// Reuses stepImages' own "already generated" skip via the same resumable mechanism as
// regenerate-script: clear what needs to redo, drop status back to the step before it, and let the
// scheduler's normal per-scene loop (and its incremental per-scene save) do the work. Allowed
// anywhere images already exist ("images", "review", "rendered") — not once published.
router.post("/episodes/:id/regenerate-images", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (!["images", "review", "rendered"].includes(episode.status)) {
      return res.status(409).json({ error: "This episode isn't at a step where images can be regenerated." });
    }
    for (const scene of episode.scenes) scene.imageUrl = null;
    episode.markModified("scenes");
    episode.status = "script"; // stepImages picks up from here and re-rolls every scene
    episode.statusDetail = "";
    await episode.save();
    scheduler.triggerNow(episode._id).catch((e) => console.error("episode triggerNow failed:", e.message));
    const fresh = await Episode.findById(episode._id).populate("scenes.charactersOnScreen", "name sprites");
    res.json(fresh);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Redo EVERY narration line's audio (and the intro line's, if this episode has one) in one go —
// for when the audio itself should be rerolled without touching the text (e.g. after changing the
// series' narratorVoice, so an already-generated episode can catch up to the new voice) rather than
// editing each line's text to force a redo.
// Same resumable-reset pattern as regenerate-images above: clear what needs to redo, drop status
// back to the step before TTS, let stepTts's own per-line skip/resume loop do the work. Allowed at
// "review" (audio already exists) and "rendered" (redo audio without touching the finished video
// until re-approving render) — not "images" (TTS hasn't run yet, nothing to redo).
router.post("/episodes/:id/regenerate-narration", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (!["review", "rendered"].includes(episode.status)) {
      return res.status(409).json({ error: "This episode isn't at a step where narration audio can be regenerated." });
    }
    for (const scene of episode.scenes) {
      for (const line of scene.narration) {
        line.audioUrl = null;
        line.durationMs = null;
      }
    }
    if (episode.intro?.text) {
      episode.intro.audioUrl = null;
      episode.intro.durationMs = null;
      episode.markModified("intro");
    }
    episode.markModified("scenes");
    episode.status = "images"; // stepTts picks up from here and re-rolls every line (and the intro)
    episode.statusDetail = "";
    await episode.save();
    scheduler.triggerNow(episode._id).catch((e) => console.error("episode triggerNow failed:", e.message));
    const fresh = await Episode.findById(episode._id).populate("scenes.charactersOnScreen", "name sprites");
    res.json(fresh);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approves an episode paused at "review" and kicks off the actual render/upload/publish chain.
// Sets status to "tts" only as a momentary internal handoff — STEP_HANDLERS.tts (stepRenderAndUpload)
// picks it up immediately via triggerNow, so it's never visibly stuck there.
router.post("/episodes/:id/approve-render", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (episode.status !== "review") {
      return res.status(409).json({ error: "This episode isn't awaiting review right now." });
    }
    episode.status = "tts";
    await episode.save();
    scheduler.triggerNow(episode._id).catch((e) => console.error("episode triggerNow failed:", e.message));
    res.json(episode);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PRIVACY_STATUSES = ["public", "unlisted", "private"];

// Kicks off the actual YouTube publish for an episode paused at "rendered" — split out from the
// render step (see stepRenderAndUpload's comment) so a human can watch the B2-hosted MP4 in the
// episode card's player and confirm it's good before it goes to the channel, instead of every
// render publishing automatically the moment it finishes. Same "momentary handoff" pattern as
// approve-render: sets status to "uploading" and triggers the scheduler, which dispatches straight
// to stepPublishToYoutube. privacyStatus/madeForKids come from the frontend's pre-upload review
// dialog — optional, since the episode's own defaults (public/made-for-kids, see Episode.js) are
// already right for this app's content; only overridden if the human actually changed them there.
router.post("/episodes/:id/upload-youtube", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (episode.status !== "rendered") {
      return res.status(409).json({ error: "This episode isn't ready to upload yet." });
    }
    const { privacyStatus, madeForKids } = req.body;
    if (privacyStatus !== undefined) {
      if (!PRIVACY_STATUSES.includes(privacyStatus)) {
        return res.status(400).json({ error: "privacyStatus must be one of: " + PRIVACY_STATUSES.join(", ") });
      }
      episode.youtubePrivacyStatus = privacyStatus;
    }
    if (typeof madeForKids === "boolean") episode.youtubeMadeForKids = madeForKids;
    episode.status = "uploading";
    await episode.save();
    scheduler.triggerNow(episode._id).catch((e) => console.error("episode triggerNow failed:", e.message));
    res.json(episode);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-renders an episode that already finished rendering — lets a human re-run the render (e.g.
// after tweaking a line/voice in review, or just to reroll) without touching the already-generated
// script/images/audio. Same "momentary handoff" pattern as approve-render: sets status
// to "tts" so STEP_HANDLERS.tts (stepRenderAndUpload) picks it up immediately via triggerNow.
// Scoped to "rendered" only (not "done"/"uploading"/"publishing") — once an episode has been
// published, re-rendering would replace the B2 copy but not the video already live on YouTube,
// which would be confusing rather than useful.
router.post("/episodes/:id/rerender", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (episode.status !== "rendered") {
      return res.status(409).json({ error: "This episode isn't in a state that can be re-rendered." });
    }
    episode.status = "tts";
    await episode.save();
    scheduler.triggerNow(episode._id).catch((e) => console.error("episode triggerNow failed:", e.message));
    res.json(episode);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resumes a stuck/failed episode from wherever it left off — the pipeline is designed to be
// safe to re-run a step (see stepImages/stepTts's "already generated" skip checks and
// stepRenderAndUpload's own "cheap and safe to redo" comment), so retry just clears the error
// and re-triggers from the step that actually needs to redo.
//
// That resume point has to be reconstructed from what's actually saved on the episode, not
// assumed — flattening every failure back to "script" (regardless of which step actually failed)
// used to send a failure from deep in the pipeline (tts/rendering/uploading — the fully-automatic
// tail that's meant to run straight through to "done" with no further clicks) all the way back
// through two dead *manual* steps, and once back in the automatic tail, stepRenderAndUpload would
// re-render the whole video from scratch even when only the final YouTube upload had failed.
// Checking what's actually missing keeps a retry exactly as cheap as the failure that caused it.
function resumeStatusAfterError(episode) {
  if (!episode.scenes?.length) return "pending";
  if (!episode.scenes.every((s) => s.imageUrl)) return "script";
  const introDone = !episode.intro?.text || episode.intro.audioUrl;
  if (!introDone || !episode.scenes.every((s) => s.narration.every((d) => d.audioUrl))) return "images";
  if (!episode.videoUrl) return "tts";
  return "uploading"; // rendered, only the YouTube publish step was left to fail
}

router.post("/episodes/:id/retry", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (episode.status === "error") {
      episode.status = resumeStatusAfterError(episode);
      episode.errorMessage = null;
      await episode.save();
    }
    scheduler.triggerNow(episode._id).catch((e) => console.error("episode triggerNow failed:", e.message));
    res.json(episode);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE an episode. Blocked only while the scheduler is literally mid-step on it right now — the
// 30s tick holds an in-memory copy of an in-progress episode and calls episode.save() on it after
// each step; deleting out from under that would make that save() throw (doc no longer exists), and
// that throw happens inside processOne's own catch block with nothing above it to catch a second
// failure, which can bring down the whole scheduler tick. Status alone can't identify that anymore
// — runDueTick only advances the earliest unfinished episode per series, so a later sibling can
// sit at a non-terminal status indefinitely, genuinely idle, while waiting its turn — so this
// checks the scheduler's real in-progress set instead of guessing safe statuses from a list.
router.delete("/episodes/:id", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (scheduler.isEpisodeInFlight(episode._id)) {
      return res.status(409).json({ error: "This episode is still being generated — wait for it to finish or error out first." });
    }
    await Episode.findByIdAndDelete(req.params.id);
    await deleteB2Prefix(`youtube/episodes/${episode._id}/`).catch(() => {});
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
