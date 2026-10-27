// User problem reports for Smoke Finder (moderators read them in /admin).
const express = require("express");
const rateLimit = require("express-rate-limit");
const SmokeReport = require("../../models/smoke/SmokeReport");
const { deviceHash, loadMeta, loadEngine } = require("./lib");

const router = express.Router();
const KINDS = ["wrong_answer", "spot", "app", "other"];
const LANGS = ["en", "zh", "ms", "ta", "th"];
const DAILY_PER_DEVICE = 10;

const reportLimiter = rateLimit({ windowMs: 60 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Too many reports. Try again later." } });

// Same Singapore boundary as /check (a rectangle would include Johor Bahru).
async function inSingapore(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const [meta, engine] = await Promise.all([loadMeta(), loadEngine()]);
  return Boolean(meta?.boundary && engine.inRings(lat, lng, meta.boundary));
}

// { kind, message?, lat?, lng?, verdict?, rules?, lang? }
router.post("/", reportLimiter, async (req, res) => {
  try {
    const device = deviceHash(req);
    if (!device) return res.status(400).json({ error: "Missing device id" });
    const { kind, message, lat, lng, verdict, rules, lang } = req.body ?? {};
    if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(", ")}` });
    const text = String(message ?? "").trim().slice(0, 1000);
    if (kind !== "wrong_answer" && !text) return res.status(400).json({ error: "Please describe the problem" });

    const today = await SmokeReport.countDocuments({ device, createdAt: { $gte: new Date(Date.now() - 86_400_000) } });
    if (today >= DAILY_PER_DEVICE) return res.status(429).json({ error: "You've sent a lot of reports today. Thank you! Try again tomorrow." });

    const withPlace = await inSingapore(Number(lat), Number(lng));
    await SmokeReport.create({
      kind,
      message: text,
      lat: withPlace ? Math.round(Number(lat) * 1e6) / 1e6 : null,
      lng: withPlace ? Math.round(Number(lng) * 1e6) / 1e6 : null,
      verdict: ["green", "amber", "red"].includes(verdict) ? verdict : null,
      rules: Array.isArray(rules) ? rules.filter((r) => typeof r === "string").slice(0, 5).map((r) => r.slice(0, 40)) : [],
      lang: LANGS.includes(lang) ? lang : "en",
      device,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
