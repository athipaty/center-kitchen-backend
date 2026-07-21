const express = require("express");
const router = express.Router();
const Series = require("../../models/youtube/Series");
const Character = require("../../models/youtube/Character");
const Episode = require("../../models/youtube/Episode");
const scheduler = require("../../jobs/youtubeEpisodeScheduler");
const { deleteB2Prefix } = require("../../utils/b2Utils");

// ── Series ──────────────────────────────────────────────────────────
router.post("/series", async (req, res) => {
  try {
    const { title, premise, genre, tone, artStyle, voiceLocale } = req.body;
    if (!title || !premise) return res.status(400).json({ error: "title and premise are required" });
    const series = await Series.create({ title, premise, genre, tone, artStyle, voiceLocale });
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
// mid-pipeline guard as the single-episode delete below: refuses if any episode isn't
// done/error yet), cleaning up each one's B2 folder along the way.
router.delete("/series/:id", async (req, res) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series) return res.status(404).json({ error: "Series not found" });

    const inFlight = await Episode.exists({ series: series._id, status: { $nin: ["done", "error"] } });
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
    const { seriesId, name, description, voiceName, attrs } = req.body;
    if (!seriesId || !name || !description || !voiceName) {
      return res.status(400).json({ error: "seriesId, name, description, and voiceName are required" });
    }
    const character = await Character.create({ series: seriesId, name, description, voiceName, attrs: attrs || null });
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
    const { name, description, voiceName, attrs } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (description !== undefined) update.description = description;
    if (voiceName !== undefined) update.voiceName = voiceName;
    if (attrs !== undefined) update.attrs = attrs;
    const character = await Character.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!character) return res.status(404).json({ error: "Character not found" });
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

// DELETE a character. Blocked while it's on-screen in an episode that's still mid-pipeline
// (not done/error) — deleting mid-render would leave that render looking up a sprite that no
// longer exists. Already-finished episodes keep referencing the character's _id harmlessly
// (their scenes/dialogue are already baked, nothing re-reads the Character doc after 'done').
router.delete("/characters/:id", async (req, res) => {
  try {
    const inFlight = await Episode.exists({
      "scenes.charactersOnScreen": req.params.id,
      status: { $nin: ["done", "error"] },
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
router.post("/episodes", async (req, res) => {
  try {
    const { seriesId, premise } = req.body;
    if (!seriesId || !premise) return res.status(400).json({ error: "seriesId and premise are required" });
    const episodeNumber = (await Episode.countDocuments({ series: seriesId })) + 1;
    const episode = await Episode.create({ series: seriesId, episodeNumber, premise });
    scheduler.triggerNow(episode._id).catch((e) => console.error("episode triggerNow failed:", e.message));
    res.json(episode);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/episodes", async (req, res) => {
  try {
    const { seriesId } = req.query;
    const filter = seriesId ? { series: seriesId } : {};
    // Populated so the "review" step can show a speaker name + their current voice next to each
    // line without a second round-trip per character.
    const episodes = await Episode.find(filter)
      .sort({ episodeNumber: -1 })
      .populate("scenes.dialogue.character", "name voiceName");
    res.json(episodes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/episodes/:id", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id).populate("scenes.dialogue.character", "name voiceName");
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    res.json(episode);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit dialogue text/expression, background prompts, and/or a character's voice while an episode
// is paused at "review" (after TTS, before the expensive render). Only touches what actually
// changed and re-enters the pipeline at the earliest step that needs to redo — reusing the same
// "already generated, skip it" guards stepBackgrounds/stepTts use for resuming after a crash, so
// unrelated scenes/lines are never regenerated.
router.put("/episodes/:id/scenes", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (episode.status !== "review") {
      return res.status(409).json({ error: "This episode isn't awaiting review right now." });
    }

    const { scenes: editedScenes = [], voiceChanges = [] } = req.body;
    let needsBackgrounds = false;
    let needsTts = false;

    // Voice changes are a character-level fix (e.g. the wrong gender voice got assigned when the
    // character was created) — update the Character so every future episode gets it too, then
    // wipe just this episode's already-recorded lines for that character so they re-synthesize.
    for (const { characterId, voiceName } of voiceChanges) {
      if (!characterId || !voiceName) continue;
      await Character.findByIdAndUpdate(characterId, { voiceName });
      for (const scene of episode.scenes) {
        for (const line of scene.dialogue) {
          if (String(line.character) === String(characterId)) {
            line.audioUrl = null;
            line.durationMs = null;
            needsTts = true;
          }
        }
      }
    }

    for (const edited of editedScenes) {
      const scene = episode.scenes.find((s) => s.order === edited.order);
      if (!scene) continue;
      if (typeof edited.backgroundPrompt === "string" && edited.backgroundPrompt.trim() !== scene.backgroundPrompt.trim()) {
        scene.backgroundPrompt = edited.backgroundPrompt.trim();
        scene.backgroundUrl = null;
        needsBackgrounds = true;
      }
      (edited.dialogue || []).forEach((editedLine, i) => {
        const line = scene.dialogue[i];
        if (!line) return;
        if (typeof editedLine.text === "string" && editedLine.text.trim() !== line.text.trim()) {
          line.text = editedLine.text.trim();
          line.audioUrl = null;
          line.durationMs = null;
          needsTts = true;
        }
        if (editedLine.expression && editedLine.expression !== line.expression) {
          line.expression = editedLine.expression; // free — every character's sprite set already covers all 5 expressions
        }
      });
    }

    episode.markModified("scenes");
    // 'sprites' and 'backgrounds' are the same safe re-entry points stepBackgrounds/stepTts's
    // "already generated" checks make resumable everywhere else in this pipeline.
    if (needsBackgrounds) episode.status = "sprites";
    else if (needsTts) episode.status = "backgrounds";
    // else: only expressions changed (or nothing did) — stays "review", nothing to regenerate.
    await episode.save();

    if (needsBackgrounds || needsTts) {
      scheduler.triggerNow(episode._id).catch((e) => console.error("episode triggerNow failed:", e.message));
    }
    const fresh = await Episode.findById(episode._id).populate("scenes.dialogue.character", "name voiceName");
    res.json(fresh);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Redo a single scene's background image using its already-saved prompt — no text edit required,
// for when the same prompt might come out looking better on a different roll. Only allowed at
// "review" (same restriction as editing scenes above) since regenerating art after the final MP4
// already exists wouldn't change anything already baked into the render.
router.post("/episodes/:id/scenes/:order/regenerate-background", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (episode.status !== "review") {
      return res.status(409).json({ error: "This episode isn't awaiting review right now." });
    }
    const order = Number(req.params.order);
    const scene = episode.scenes.find((s) => s.order === order);
    if (!scene) return res.status(404).json({ error: "Scene not found" });

    await scheduler.regenerateSceneBackground(episode, scene);
    const fresh = await Episode.findById(episode._id).populate("scenes.dialogue.character", "name voiceName");
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

// Kicks off the actual YouTube publish for an episode paused at "rendered" — split out from the
// render step (see stepRenderAndUpload's comment) so a human can watch the B2-hosted MP4 in the
// episode card's player and confirm it's good before it goes to the channel, instead of every
// render publishing automatically the moment it finishes. Same "momentary handoff" pattern as
// approve-render: sets status to "uploading" and triggers the scheduler, which dispatches straight
// to stepPublishToYoutube.
router.post("/episodes/:id/upload-youtube", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (episode.status !== "rendered") {
      return res.status(409).json({ error: "This episode isn't ready to upload yet." });
    }
    episode.status = "uploading";
    await episode.save();
    scheduler.triggerNow(episode._id).catch((e) => console.error("episode triggerNow failed:", e.message));
    res.json(episode);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resumes a stuck/failed episode from wherever it left off — the pipeline is designed to be
// safe to re-run a step (see stepBackgrounds/stepTts's "already generated" skip checks and
// stepRenderAndUpload's comment), so retry just clears the error and re-triggers.
router.post("/episodes/:id/retry", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (episode.status === "error") {
      // 'sprites' is a safe universal re-entry point once a script exists: stepSprites skips
      // characters already status:'ready', stepBackgrounds/stepTts skip scenes/lines that
      // already have a backgroundUrl/audioUrl — so resuming here never redoes finished work.
      episode.status = episode.scenes?.length ? "script" : "pending";
      episode.errorMessage = null;
      await episode.save();
    }
    scheduler.triggerNow(episode._id).catch((e) => console.error("episode triggerNow failed:", e.message));
    res.json(episode);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE an episode. Only allowed once it's settled (done or error) — the scheduler's 30s tick
// holds an in-memory copy of an in-progress episode and calls episode.save() on it after each
// step; deleting out from under that would make that save() throw (doc no longer exists), and
// that throw happens inside processOne's own catch block with nothing above it to catch a
// second failure, which can bring down the whole scheduler tick.
router.delete("/episodes/:id", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (!["done", "error"].includes(episode.status)) {
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
