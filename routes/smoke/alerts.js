// Opt-in push alerts when the rules change at a user's saved spots.
const express = require("express");
const rateLimit = require("express-rate-limit");
const SmokeAlert = require("../../models/smoke/SmokeAlert");
const { readPoint, checkPoint, deviceHash, loadEngine, loadMeta } = require("./lib");
const { pushConfigured } = require("./push");

const router = express.Router();
const MAX_POINTS = 20;
const LANGS = ["en", "zh", "ms", "ta", "th"];

const alertLimiter = rateLimit({ windowMs: 60 * 60_000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Too many changes. Try again later." } });

function validSubscription(s) {
  return (
    s &&
    typeof s.endpoint === "string" &&
    /^https:\/\//.test(s.endpoint) &&
    s.endpoint.length < 1000 &&
    typeof s.keys?.p256dh === "string" &&
    typeof s.keys?.auth === "string"
  );
}

// Checks each point now so later runs can tell what changed.
async function withVerdicts(points) {
  const [meta, engine] = await Promise.all([loadMeta(), loadEngine()]);
  return Promise.all(
    points.map(async (p) => {
      const result = await checkPoint({ lat: p.lat, lng: p.lng, accuracyM: 0, meta, engine });
      return { ...p, verdict: result.verdict, rule: result.reasons[0]?.rule ?? null };
    })
  );
}

router.get("/key", (_req, res) => {
  if (!pushConfigured()) return res.status(503).json({ error: "Alerts are not set up yet" });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

router.get("/", async (req, res) => {
  try {
    const device = deviceHash(req);
    if (!device) return res.status(400).json({ error: "Missing device id" });
    const alert = await SmokeAlert.findOne({ device }).lean();
    res.json({ enabled: Boolean(alert), points: alert?.points.length ?? 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Turn on, or update the saved spots: { subscription, lang, points: [{ key, label, lat, lng }] }
router.put("/", alertLimiter, async (req, res) => {
  try {
    if (!pushConfigured()) return res.status(503).json({ error: "Alerts are not set up yet" });
    const device = deviceHash(req);
    if (!device) return res.status(400).json({ error: "Missing device id" });
    const { subscription, lang, points } = req.body ?? {};
    if (!validSubscription(subscription)) return res.status(400).json({ error: "Invalid push subscription" });
    if (!Array.isArray(points) || points.length > MAX_POINTS) {
      return res.status(400).json({ error: `points must be a list of up to ${MAX_POINTS} spots` });
    }

    const clean = [];
    for (const p of points) {
      const point = await readPoint(p, res); // same Singapore + data checks as /check
      if (!point) return;
      clean.push({
        key: String(p.key ?? "").slice(0, 80),
        label: String(p.label ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "Saved spot",
        lat: point.lat,
        lng: point.lng,
      });
    }

    const alert = await SmokeAlert.findOneAndUpdate(
      { device },
      {
        device,
        subscription: { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } },
        lang: LANGS.includes(lang) ? lang : "en",
        points: await withVerdicts(clean),
      },
      { upsert: true, new: true, runValidators: true }
    ).lean();
    res.json({ enabled: true, points: alert.points.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Turn off: deletes everything stored for this device.
router.delete("/", async (req, res) => {
  try {
    const device = deviceHash(req);
    if (!device) return res.status(400).json({ error: "Missing device id" });
    await SmokeAlert.deleteOne({ device });
    res.json({ enabled: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
