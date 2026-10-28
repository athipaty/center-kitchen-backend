// Community spots: add (F5), confirm / report (F6).
const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const sharp = require("sharp");
const rateLimit = require("express-rate-limit");
const SmokeSpot = require("../../models/smoke/SmokeSpot");
const { uploadToB2, b2Enabled } = require("../../utils/b2Utils");
const { readPoint, checkPoint, deviceHash } = require("./lib");
const { notifyModerator } = require("./notify");
const { isModerator } = require("./moderator");
const stats = require("./stats");

const router = express.Router();

const VERIFY_AT = 3; // "Still here" votes (the adder counts as one)
const HIDE_AT = 3; // "Gone" or "Not allowed here" votes
const PHOTO_HIDE_AT = 2; // "Bad photo" votes
const STALE_DAYS = 90;
const DUPLICATE_M = 15;
const DAILY_ADDS_PER_DEVICE = 5;
const B2_PREFIX = "smoke-spots/";

// Moderators seeding spots skip the limits for new spots.
const addLimiter = rateLimit({ windowMs: 60 * 60_000, max: 10, skip: isModerator, standardHeaders: true, legacyHeaders: false, message: { error: "Too many new spots from this network. Try again later." } });
const voteLimiter = rateLimit({ windowMs: 60 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: "Too many votes. Try again later." } });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype)),
});

// Resize, convert to WebP, and drop EXIF (phone photos carry the GPS of where they were taken).
const toWebp = (buf) =>
  sharp(buf).rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();

const asBool = (v) => v === true || v === "true" || v === "1" || v === "on";

function cleanName(raw) {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return name || null;
}

// "24h" is stored as is (the app translates it); anything else as typed.
function cleanHours(raw) {
  const hours = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!hours) return null;
  return /^(24h|24 ?hours?|24\/7)$/i.test(hours) ? "24h" : hours;
}

// Recomputes counts and status from the votes.
function tally(spot) {
  const count = (type) => spot.votes.filter((v) => v.type === type).length;
  spot.hereCount = count("here");
  spot.goneCount = count("gone");
  spot.notAllowedCount = count("not_allowed");
  spot.badPhotoCount = count("bad_photo");
  spot.photoHidden = spot.photoAdminHidden || spot.badPhotoCount >= PHOTO_HIDE_AT;
  if (spot.goneCount >= HIDE_AT || spot.notAllowedCount >= HIDE_AT) spot.status = "hidden";
  else spot.status = spot.hereCount >= VERIFY_AT || spot.addedByModerator ? "verified" : "unverified";
}

// What the app sees: no device hashes, only the caller's own vote.
function toPublic(spot, device) {
  const daysSince = (Date.now() - new Date(spot.lastConfirmedAt).getTime()) / 86_400_000;
  return {
    id: String(spot._id),
    name: spot.name,
    lat: spot.lat,
    lng: spot.lng,
    sheltered: spot.sheltered,
    hasAshtray: spot.hasAshtray,
    hasSeating: spot.hasSeating,
    hours: spot.hours ?? null,
    photo: spot.photoHidden ? null : spot.photoUrl,
    status: spot.status,
    byModerator: Boolean(spot.addedByModerator),
    stale: daysSince > STALE_DAYS,
    lastConfirmedAt: spot.lastConfirmedAt,
    hereCount: spot.hereCount,
    goneCount: spot.goneCount,
    notAllowedCount: spot.notAllowedCount,
    myVote: device ? spot.votes.find((v) => v.device === device && v.type !== "bad_photo")?.type ?? null : null,
    mine: device ? spot.createdBy === device : false,
  };
}

// Visible community spots near a point, nearest first. Used by /nearby.
async function communityNear(lat, lng, metres, limit, device) {
  const spots = await SmokeSpot.find({
    status: { $ne: "hidden" },
    location: { $nearSphere: { $geometry: { type: "Point", coordinates: [lng, lat] }, $maxDistance: metres } },
  })
    .limit(limit)
    .lean();
  return spots.map((s) => toPublic(s, device));
}

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Spot not found" });
    const spot = await SmokeSpot.findById(req.params.id).lean();
    if (!spot || spot.status === "hidden") return res.status(404).json({ error: "Spot not found" });
    res.json(toPublic(spot, deviceHash(req)));
    stats.count("spotViews");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// F5: add a spot. multipart/form-data: lat, lng, name?, sheltered, hasAshtray, hasSeating, hours?, photo?
router.post("/", addLimiter, (req, res) => {
  upload.single("photo")(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        return res.status(400).json({ error: uploadErr.code === "LIMIT_FILE_SIZE" ? "Photo is larger than 8 MB" : "Photo upload failed" });
      }
      const device = deviceHash(req);
      if (!device) return res.status(400).json({ error: "Missing device id" });

      const point = await readPoint(req.body, res);
      if (!point) return;
      const { lat, lng } = point;

      const moderator = isModerator(req);
      const today = moderator ? 0 : await SmokeSpot.countDocuments({ createdBy: device, createdAt: { $gte: new Date(Date.now() - 86_400_000) } });
      if (today >= DAILY_ADDS_PER_DEVICE) {
        return res.status(429).json({ error: `You can add up to ${DAILY_ADDS_PER_DEVICE} spots a day.` });
      }

      // Same rules as F1: no community spot in a no-smoking place.
      const result = await checkPoint(point);
      if (result.designatedArea) {
        return res.status(409).json({ error: "This is already an NEA designated smoking area." });
      }
      if (result.verdict === "red") {
        return res.status(422).json({ error: `Smoking isn't allowed here: ${result.reasons[0]?.label ?? "no-smoking place"}.`, check: result });
      }

      const existing = await SmokeSpot.findOne({
        status: { $ne: "hidden" },
        location: { $nearSphere: { $geometry: { type: "Point", coordinates: [lng, lat] }, $maxDistance: DUPLICATE_M } },
      }).lean();
      if (existing) {
        return res.status(409).json({ error: "There's already a spot here. You can confirm it instead.", spot: toPublic(existing, device) });
      }

      let photoUrl = null;
      let photoKey = null;
      if (req.file) {
        if (!b2Enabled()) return res.status(503).json({ error: "Photo storage isn't set up. Try again without a photo." });
        let image;
        try {
          image = await toWebp(req.file.buffer);
        } catch {
          return res.status(400).json({ error: "That file isn't a supported image" });
        }
        photoKey = `${B2_PREFIX}${Date.now()}-${crypto.randomUUID()}.webp`;
        photoUrl = await uploadToB2(image, photoKey, "image/webp");
      }

      const spot = new SmokeSpot({
        name: cleanName(req.body.name),
        lat,
        lng,
        location: { type: "Point", coordinates: [lng, lat] },
        sheltered: asBool(req.body.sheltered),
        hasAshtray: asBool(req.body.hasAshtray),
        hasSeating: asBool(req.body.hasSeating),
        hours: cleanHours(req.body.hours),
        photoUrl,
        photoKey,
        verdictAtAdd: result.verdict,
        createdBy: device,
        addedByModerator: moderator,
        votes: [{ device, type: "here" }],
      });
      tally(spot);
      await spot.save();
      res.status(201).json(toPublic(spot.toObject(), device));
      stats.count("adds");
      if (!moderator) notifyModerator("Smoke Finder: new spot added", `${spot.name ?? "Unnamed spot"}${photoUrl ? " (with photo)" : ""}. Check it in Moderation.`);
    } catch (err) {
      console.error("smoke: add spot failed:", err.message);
      res.status(500).json({ error: "Couldn't save the spot. Please try again." });
    }
  });
});

// F6: { type: "here" | "gone" | "not_allowed" | "bad_photo" }
router.post("/:id/vote", voteLimiter, async (req, res) => {
  try {
    const device = deviceHash(req);
    if (!device) return res.status(400).json({ error: "Missing device id" });
    const type = req.body?.type;
    if (!["here", "gone", "not_allowed", "bad_photo"].includes(type)) {
      return res.status(400).json({ error: "type must be here, gone, not_allowed or bad_photo" });
    }
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Spot not found" });

    const spot = await SmokeSpot.findById(req.params.id);
    if (!spot || spot.status === "hidden") return res.status(404).json({ error: "Spot not found" });

    // A photo report sits alongside the device's spot vote; the others replace it.
    const replaces = type === "bad_photo" ? (v) => v.type === "bad_photo" : (v) => v.type !== "bad_photo";
    spot.votes = spot.votes.filter((v) => !(v.device === device && replaces(v)));
    spot.votes.push({ device, type });
    if (type === "here") spot.lastConfirmedAt = new Date();
    tally(spot);
    await spot.save();
    res.json(toPublic(spot.toObject(), device));
    stats.count(`votes.${type}`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.communityNear = communityNear;
module.exports.tally = tally;
module.exports.cleanName = cleanName;
module.exports.cleanHours = cleanHours;
