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

// ── Characters ──────────────────────────────────────────────────────
router.post("/characters", async (req, res) => {
  try {
    const { seriesId, name, description, voiceName } = req.body;
    if (!seriesId || !name || !description || !voiceName) {
      return res.status(400).json({ error: "seriesId, name, description, and voiceName are required" });
    }
    const character = await Character.create({ series: seriesId, name, description, voiceName });
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

// Kicks off sprite generation immediately (not queued) — a single character's ~5 sprites take
// well under a minute even at Pollinations' rate limit, short enough to just await inline rather
// than routing through the episode job pipeline's status machinery.
router.post("/characters/:id/generate-sprites", async (req, res) => {
  try {
    const character = await Character.findById(req.params.id);
    if (!character) return res.status(404).json({ error: "Character not found" });
    const io = req.app.get("io");
    await scheduler.generateCharacterSprites(character, async (expression) => {
      io?.emit("character:progress", { characterId: String(character._id), expression });
    });
    res.json(character);
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
    const episodes = await Episode.find(filter).sort({ episodeNumber: -1 });
    res.json(episodes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/episodes/:id", async (req, res) => {
  try {
    const episode = await Episode.findById(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
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
