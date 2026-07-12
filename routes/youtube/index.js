const express = require("express");
const router = express.Router();
const Series = require("../../models/youtube/Series");
const Character = require("../../models/youtube/Character");
const Episode = require("../../models/youtube/Episode");
const scheduler = require("../../jobs/youtubeEpisodeScheduler");

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
    await scheduler.generateCharacterSprites(character);
    res.json(character);
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

module.exports = router;
