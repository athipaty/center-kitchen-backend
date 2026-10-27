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
