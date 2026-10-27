// Smoke Finder moderation: review hidden spots and reported photos.
//
// Own password and JWT secret, no defaults (same reasoning as Direk Air: the shared
// Token collection isn't scoped per project). Login is disabled until both are set.
//   SMOKE_ADMIN_PASSWORD  moderator password
//   SMOKE_JWT_SECRET      signs moderator tokens (long random string)
const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const SmokeSpot = require("../../models/smoke/SmokeSpot");
const SmokeStat = require("../../models/smoke/SmokeStat");
const SmokeDevice = require("../../models/smoke/SmokeDevice");
const SmokeAlert = require("../../models/smoke/SmokeAlert");
const SmokeReport = require("../../models/smoke/SmokeReport");
const { sgDay, addDays } = require("./stats");
const { deleteB2File } = require("../../utils/b2Utils");
const { tally } = require("./spots");

const router = express.Router();
const TOKEN_AUDIENCE = "smoke-finder";
const REVIEW_LIMIT = 100;

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many wrong passwords. Wait 15 minutes." },
});

const configured = () => !!(process.env.SMOKE_ADMIN_PASSWORD && process.env.SMOKE_JWT_SECRET);

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireAdmin(req, res, next) {
  if (!configured()) return res.status(503).json({ error: "Moderation is not set up yet" });
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Please log in" });
  try {
    jwt.verify(header.slice(7), process.env.SMOKE_JWT_SECRET, { audience: TOKEN_AUDIENCE });
    next();
  } catch {
    res.status(401).json({ error: "Please log in again" });
  }
}

// Everything a moderator needs, still without device hashes.
const toReview = (s) => ({
  id: String(s._id),
  name: s.name,
  lat: s.lat,
  lng: s.lng,
  sheltered: s.sheltered,
  hasAshtray: s.hasAshtray,
  hasSeating: s.hasSeating,
  photoUrl: s.photoUrl,
  photoHidden: s.photoHidden,
  photoAdminHidden: s.photoAdminHidden ?? false,
  status: s.status,
  verdictAtAdd: s.verdictAtAdd,
  hereCount: s.hereCount,
  goneCount: s.goneCount,
  notAllowedCount: s.notAllowedCount,
  badPhotoCount: s.badPhotoCount,
  lastConfirmedAt: s.lastConfirmedAt,
  createdAt: s.createdAt,
});

async function findSpot(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: "Spot not found" });
    return null;
  }
  const spot = await SmokeSpot.findById(req.params.id);
  if (!spot) res.status(404).json({ error: "Spot not found" });
  return spot;
}

router.post("/login", loginLimiter, (req, res) => {
  if (!configured()) return res.status(503).json({ error: "Moderation is not set up yet" });
  if (!safeEqual(req.body?.password ?? "", process.env.SMOKE_ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Wrong password" });
  }
  const token = jwt.sign({ role: "admin" }, process.env.SMOKE_JWT_SECRET, { audience: TOKEN_AUDIENCE, expiresIn: "7d" });
  res.json({ token });
});

router.get("/me", requireAdmin, (_req, res) => res.json({ admin: true }));

// User problem reports. ?status=open (default) | done | all
router.get("/reports", requireAdmin, async (req, res) => {
  try {
    const status = ["open", "done"].includes(req.query.status) ? { status: req.query.status } : req.query.status === "all" ? {} : { status: "open" };
    const [reports, open] = await Promise.all([
      SmokeReport.find(status).sort({ createdAt: -1 }).limit(REVIEW_LIMIT).select("-device").lean(),
      SmokeReport.countDocuments({ status: "open" }),
    ]);
    res.json({ open, reports: reports.map(({ _id, ...r }) => ({ id: String(_id), ...r })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// { status: "open" | "done" }
router.post("/reports/:id", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Report not found" });
    if (!["open", "done"].includes(req.body?.status)) return res.status(400).json({ error: "status must be open or done" });
    const report = await SmokeReport.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true }).select("-device").lean();
    if (!report) return res.status(404).json({ error: "Report not found" });
    const { _id, ...rest } = report;
    res.json({ id: String(_id), ...rest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The spec's success metrics (targets for 3 months after launch).
const ORCHARD = { lat: 1.3035, lng: 103.8335 }; // centre of the Orchard Road NSZ
const ORCHARD_RADIUS_M = 1500;
const metresFrom = (a, b) =>
  Math.hypot((a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180), (a.lat - b.lat) * 110574);

router.get("/metrics", requireAdmin, async (_req, res) => {
  try {
    const today = sgDay();
    const from14 = sgDay(-13);
    const from7 = sgDay(-6);
    const db = SmokeStat.db;

    const [daily, weeklyActives, cohort, spots, meta, alertsRun, alertDevices] = await Promise.all([
      SmokeStat.find({ _id: { $gte: from14 } }).sort({ _id: 1 }).lean(),
      SmokeDevice.countDocuments({ last: { $gte: from7 } }),
      // D7 retention cohort: first seen 7 to 13 days ago, so day 7 has happened
      SmokeDevice.find({ first: { $gte: sgDay(-13), $lte: sgDay(-7) } }).select("first days").lean(),
      SmokeSpot.find().select("lat lng status lastConfirmedAt").lean(),
      db.collection("smokemeta").findOne({ _id: "current" }, { projection: { boundary: 0 } }),
      db.collection("smokemeta").findOne({ _id: "alertsRun" }),
      SmokeAlert.countDocuments(),
    ]);

    // One row per day for the last 14 days, zeros where nothing happened.
    const byDay = Object.fromEntries(daily.map((d) => [d._id, d]));
    const days = Array.from({ length: 14 }, (_, i) => addDays(from14, i)).map((day) => {
      const d = byDay[day] ?? {};
      const v = d.votes ?? {};
      return {
        day,
        actives: d.actives ?? 0,
        newDevices: d.newDevices ?? 0,
        checks: d.checks ?? 0,
        nearby: d.nearby ?? 0,
        spotViews: d.spotViews ?? 0,
        adds: d.adds ?? 0,
        checkins: d.checkins ?? 0,
        reports: (v.gone ?? 0) + (v.not_allowed ?? 0),
        confirms: v.here ?? 0,
      };
    });
    const last7 = days.filter((d) => d.day >= from7);
    const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);

    const retained = cohort.filter((c) => c.days.some((d) => d >= addDays(c.first, 7))).length;
    const visible = spots.filter((s) => s.status !== "hidden");
    const recent = Date.now() - 90 * 86_400_000;
    const views7 = sum(last7, "spotViews");
    const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

    res.json({
      today,
      targets: {
        spots: { value: visible.length, target: 1000 },
        spotsOutsideOrchardPct: { value: pct(visible.filter((s) => metresFrom(s, ORCHARD) > ORCHARD_RADIUS_M).length, visible.length), target: 30 },
        weeklyActives: { value: weeklyActives, target: 2000 },
        day7RetentionPct: { value: pct(retained, cohort.length), target: 25, cohort: cohort.length },
        confirmedLast90DaysPct: { value: pct(visible.filter((s) => new Date(s.lastConfirmedAt).getTime() >= recent).length, visible.length), target: 70 },
        reportsPer100Views: { value: views7 ? Math.round((sum(last7, "reports") / views7) * 1000) / 10 : null, target: 3, lowerIsBetter: true },
        checksPerActivePerWeek: { value: weeklyActives ? Math.round((sum(last7, "checks") / weeklyActives) * 10) / 10 : null, target: 5 },
      },
      days,
      spots: {
        visible: visible.length,
        verified: spots.filter((s) => s.status === "verified").length,
        hidden: spots.length - visible.length,
      },
      data: {
        builtAt: meta?.builtAt ?? null,
        importedAt: meta?.importedAt ?? null,
        zones: meta ? Object.values(meta.counts ?? {}).reduce((a, b) => a + b, 0) : 0,
        alertsLastRun: alertsRun ? { ranAt: alertsRun.ranAt, summary: alertsRun.summary } : null,
        alertDevices,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ?filter=review (default: hidden, or any reports) | hidden | photos | all
router.get("/spots", requireAdmin, async (req, res) => {
  try {
    const filters = {
      review: { $or: [{ status: "hidden" }, { goneCount: { $gt: 0 } }, { notAllowedCount: { $gt: 0 } }, { badPhotoCount: { $gt: 0 } }] },
      hidden: { status: "hidden" },
      photos: { badPhotoCount: { $gt: 0 } },
      all: {},
    };
    const filter = filters[req.query.filter] ?? filters.review;
    const [spots, counts] = await Promise.all([
      SmokeSpot.find(filter).sort({ updatedAt: -1 }).limit(REVIEW_LIMIT).lean(),
      SmokeSpot.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    res.json({ spots: spots.map(toReview), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Wrongly hidden: drop its "gone" / "not allowed" votes so it shows again.
router.post("/spots/:id/restore", requireAdmin, async (req, res) => {
  try {
    const spot = await findSpot(req, res);
    if (!spot) return;
    spot.votes = spot.votes.filter((v) => v.type !== "gone" && v.type !== "not_allowed");
    tally(spot);
    await spot.save();
    res.json(toReview(spot.toObject()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// { action: "show" (clear photo reports) | "hide" | "delete" (remove from storage) }
router.post("/spots/:id/photo", requireAdmin, async (req, res) => {
  try {
    const action = req.body?.action;
    if (!["show", "hide", "delete"].includes(action)) return res.status(400).json({ error: "action must be show, hide or delete" });
    const spot = await findSpot(req, res);
    if (!spot) return;
    if (!spot.photoUrl) return res.status(400).json({ error: "This spot has no photo" });

    if (action === "delete") {
      await deleteB2File(spot.photoKey);
      spot.photoUrl = null;
      spot.photoKey = null;
    }
    // Photo reports are cleared either way so tally() doesn't re-hide a photo just shown.
    spot.votes = spot.votes.filter((v) => v.type !== "bad_photo");
    spot.photoAdminHidden = action === "hide";
    tally(spot);
    await spot.save();
    res.json(toReview(spot.toObject()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/spots/:id", requireAdmin, async (req, res) => {
  try {
    const spot = await findSpot(req, res);
    if (!spot) return;
    if (spot.photoKey) await deleteB2File(spot.photoKey);
    await spot.deleteOne();
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
