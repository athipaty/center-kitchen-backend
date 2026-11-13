const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const EmberAccount = require("../../models/embervale/EmberAccount");
const { signEmbervaleToken, requireEmbervaleAuth } = require("../../utils/embervaleAuth");
const { onlineCount } = require("./socket");
const { errorsRouter } = require("./errors");

const USERNAME_RE = /^[a-z0-9_]{3,16}$/;
const MAX_SAVE_BYTES = 200_000;

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes." },
});
const saveLimiter = rateLimit({
  windowMs: 60_000,
  max: 90, // every storage move is a save too (shared storage), so allow a busy minute at the bank
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Saving too often. Slow down." },
});

function readCredentials(body) {
  const username = String(body?.username ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  if (!USERNAME_RE.test(username)) return { error: "Username must be 3-16 letters, numbers or _" };
  if (password.length < 6 || password.length > 100) return { error: "Password must be at least 6 characters" };
  return { username, password };
}

const session = (acct) => ({ token: signEmbervaleToken({ id: String(acct._id), username: acct.username }), username: acct.username });

router.post("/register", authLimiter, async (req, res) => {
  try {
    const c = readCredentials(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    if (await EmberAccount.exists({ username: c.username })) return res.status(409).json({ error: "That username is taken" });
    const acct = await EmberAccount.create({ username: c.username, passwordHash: await bcrypt.hash(c.password, 10) });
    res.status(201).json(session(acct));
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: "That username is taken" });
    res.status(500).json({ error: "Could not create the account" });
  }
});

router.post("/login", authLimiter, async (req, res) => {
  try {
    const c = readCredentials(req.body);
    if (c.error) return res.status(400).json({ error: "Wrong username or password" });
    const acct = await EmberAccount.findOne({ username: c.username });
    if (!acct || !(await bcrypt.compare(c.password, acct.passwordHash))) return res.status(401).json({ error: "Wrong username or password" });
    res.json(session(acct));
  } catch {
    res.status(500).json({ error: "Could not log in" });
  }
});

// ---- characters: every account has CHAR_SLOTS slots, chosen with ?slot=0..2 (default 0).
// Slot 0 is the original "character" field, so saves made before slots existed stay where they are.
const CHAR_SLOTS = 3;
const STORAGE_MAX_ENTRIES = 400;
function slotOf(req) {
  const n = req.query?.slot === undefined ? 0 : Number(req.query.slot);
  return Number.isInteger(n) && n >= 0 && n < CHAR_SLOTS ? n : -1;
}
const charField = (n) => (n ? "character" + n : "character");
const savedField = (n) => charField(n) + "SavedAt";
const NO_ACCOUNT = { error: "Account not found. Please log in again." };

// Every slot in short (for the character select screen) plus the shared storage.
router.get("/characters", requireEmbervaleAuth, async (req, res) => {
  try {
    const proj = { username: 1, storage: 1, storageRev: 1 };
    for (let n = 0; n < CHAR_SLOTS; n++) { proj[charField(n)] = 1; proj[savedField(n)] = 1; }
    const acct = await EmberAccount.findById(req.ember.id, proj).lean();
    if (!acct) return res.status(401).json(NO_ACCOUNT);
    const slots = [];
    for (let n = 0; n < CHAR_SLOTS; n++) {
      const c = acct[charField(n)], p = c && c.p;
      slots.push(p ? { name: p.name, lv: p.lv, jl: p.jl, cls: p.cls, look: p.look, reborn: p.reborn, zone: p.zone, savedAt: acct[savedField(n)] ?? null } : null);
    }
    res.json({ username: acct.username, slots, storage: acct.storage ?? null, storageRev: acct.storageRev || 0 });
  } catch {
    res.status(500).json({ error: "Could not load your characters" });
  }
});

router.get("/character", requireEmbervaleAuth, async (req, res) => {
  const n = slotOf(req);
  if (n < 0) return res.status(400).json({ error: "No such character slot" });
  try {
    const acct = await EmberAccount.findById(req.ember.id, { [charField(n)]: 1, [savedField(n)]: 1, username: 1, storage: 1, storageRev: 1 }).lean();
    if (!acct) return res.status(401).json(NO_ACCOUNT);
    res.json({ username: acct.username, slot: n, character: acct[charField(n)] ?? null, savedAt: acct[savedField(n)] ?? null,
      storage: acct.storage ?? null, storageRev: acct.storageRev || 0 });
  } catch {
    res.status(500).json({ error: "Could not load your character" });
  }
});

// Saves a character. With "storage" in the body it also replaces the shared storage, in the same write,
// but only if "storageRev" still matches (otherwise 409 with the current storage, and nothing is saved).
router.put("/character", requireEmbervaleAuth, saveLimiter, async (req, res) => {
  const n = slotOf(req);
  if (n < 0) return res.status(400).json({ error: "No such character slot" });
  try {
    const save = req.body?.character;
    const ok = save && typeof save === "object" && save.v === 1 && save.p && typeof save.p === "object" &&
      typeof save.p.name === "string" && save.p.name.length >= 1 && save.p.name.length <= 16;
    if (!ok) return res.status(400).json({ error: "Not a valid character save" });
    const storage = req.body?.storage;
    if (storage !== undefined && (!Array.isArray(storage) || storage.length > STORAGE_MAX_ENTRIES || storage.some((e) => !e || typeof e !== "object")))
      return res.status(400).json({ error: "Not a valid storage" });
    if (JSON.stringify(save).length + (storage ? JSON.stringify(storage).length : 0) > MAX_SAVE_BYTES)
      return res.status(413).json({ error: "Save is too large" });
    const set = { [charField(n)]: save, [savedField(n)]: new Date() };
    const filter = { _id: req.ember.id };
    let rev;
    if (storage !== undefined) {
      rev = Math.max(0, Math.floor(Number(req.body.storageRev) || 0));
      filter.storageRev = rev === 0 ? { $in: [0, null] } : rev; // accounts made before storageRev have no field
      set.storage = storage;
      set.storageRev = rev + 1;
    }
    const r = await EmberAccount.updateOne(filter, set);
    if (!r.matchedCount) {
      const acct = await EmberAccount.findById(req.ember.id, { storage: 1, storageRev: 1 }).lean();
      if (!acct) return res.status(401).json(NO_ACCOUNT);
      return res.status(409).json({ error: "Your storage was changed by another of your characters. Try again.", storage: acct.storage ?? null, storageRev: acct.storageRev || 0 });
    }
    res.json(storage !== undefined ? { ok: true, slot: n, storageRev: rev + 1 } : { ok: true, slot: n });
  } catch {
    res.status(500).json({ error: "Could not save your character" });
  }
});

router.delete("/character", requireEmbervaleAuth, async (req, res) => {
  const n = slotOf(req);
  if (n < 0) return res.status(400).json({ error: "No such character slot" });
  try {
    await EmberAccount.updateOne({ _id: req.ember.id }, { [charField(n)]: null, [savedField(n)]: null });
    res.json({ ok: true, slot: n });
  } catch {
    res.status(500).json({ error: "Could not delete the character" });
  }
});

// Error reports from players' games, and admin backups (routes/embervale/errors.js)
router.use(errorsRouter);

// Public: how many players are connected (for a landing page or the title screen).
router.get("/status", (req, res) => res.json({ online: onlineCount() }));

module.exports = router;
