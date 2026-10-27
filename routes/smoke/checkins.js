// "Busy now": people say "I'm here now" at a spot; others see how many did in
// the last hour. Only community spots and NEA areas can be checked in to.
// At a community spot it also counts as that phone's "Still here" vote:
// being there is the best proof the spot exists.
const express = require("express");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const SmokeCheckin = require("../../models/smoke/SmokeCheckin");
const SmokeSpot = require("../../models/smoke/SmokeSpot");
const SmokeDsa = require("../../models/smoke/SmokeDsa");
const { deviceHash } = require("./lib");
const { tally } = require("./spots");
const stats = require("./stats");

const router = express.Router();

const RECENT_MS = 60 * 60_000;

const checkinLimiter = rateLimit({ windowMs: 60 * 60_000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Too many check-ins. Try again later." } });

const communityKey = (id) => `c:${id}`;
const dsaKey = (neaId) => `nea:${neaId}`;

// True if the key names a spot that exists and isn't hidden.
async function spotExists(key) {
  const [kind, id] = String(key ?? "").split(":");
  if (kind === "c" && mongoose.isValidObjectId(id)) return Boolean(await SmokeSpot.exists({ _id: id, status: { $ne: "hidden" } }));
  if (kind === "nea" && /^\d+$/.test(id ?? "")) return Boolean(await SmokeDsa.exists({ neaId: Number(id) }));
  return false;
}

// { key: number of people checked in during the last hour } for the given keys.
async function busyFor(keys) {
  if (!keys.length) return {};
  const rows = await SmokeCheckin.aggregate([
    { $match: { spot: { $in: keys }, at: { $gte: new Date(Date.now() - RECENT_MS) } } },
    { $group: { _id: "$spot", n: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

async function statusFor(key, device) {
  const [busy, mine] = await Promise.all([
    busyFor([key]),
    device ? SmokeCheckin.exists({ _id: device, spot: key, at: { $gte: new Date(Date.now() - RECENT_MS) } }) : null,
  ]);
  return { busyNow: busy[key] ?? 0, here: Boolean(mine) };
}

// Same as a "Still here" vote (see spots.js): replaces the phone's earlier vote.
async function confirmSpot(id, device) {
  const spot = await SmokeSpot.findById(id);
  if (!spot) return;
  spot.votes = spot.votes.filter((v) => !(v.device === device && v.type !== "bad_photo"));
  spot.votes.push({ device, type: "here" });
  spot.lastConfirmedAt = new Date();
  tally(spot);
  await spot.save();
}

// GET /api/smoke/checkins?spot=c:<id>  ->  { busyNow, here }
router.get("/", async (req, res) => {
  try {
    const key = String(req.query.spot ?? "");
    if (!(await spotExists(key))) return res.status(404).json({ error: "Spot not found" });
    res.json(await statusFor(key, deviceHash(req)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST { spot: "c:<id>" | "nea:<id>" }: I'm here now.
router.post("/", checkinLimiter, async (req, res) => {
  try {
    const device = deviceHash(req);
    if (!device) return res.status(400).json({ error: "Missing device id" });
    const key = String(req.body?.spot ?? "");
    if (!(await spotExists(key))) return res.status(404).json({ error: "Spot not found" });
    await SmokeCheckin.updateOne({ _id: device }, { $set: { spot: key, at: new Date() } }, { upsert: true });
    if (key.startsWith("c:")) await confirmSpot(key.slice(2), device);
    res.json(await statusFor(key, device));
    stats.count("checkins");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE: I've left.
router.delete("/", async (req, res) => {
  try {
    const device = deviceHash(req);
    if (!device) return res.status(400).json({ error: "Missing device id" });
    const before = await SmokeCheckin.findOneAndDelete({ _id: device }).lean();
    res.json(before ? await statusFor(before.spot, null) : { busyNow: 0, here: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.busyFor = busyFor;
module.exports.communityKey = communityKey;
module.exports.dsaKey = dsaKey;
