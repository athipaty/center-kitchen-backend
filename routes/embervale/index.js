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
  max: 30,
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

router.get("/character", requireEmbervaleAuth, async (req, res) => {
  try {
    const acct = await EmberAccount.findById(req.ember.id, { character: 1, characterSavedAt: 1, username: 1 }).lean();
    if (!acct) return res.status(401).json({ error: "Account not found. Please log in again." });
    res.json({ username: acct.username, character: acct.character, savedAt: acct.characterSavedAt });
  } catch {
    res.status(500).json({ error: "Could not load your character" });
  }
});

router.put("/character", requireEmbervaleAuth, saveLimiter, async (req, res) => {
  try {
    const save = req.body?.character;
    const ok = save && typeof save === "object" && save.v === 1 && save.p && typeof save.p === "object" &&
      typeof save.p.name === "string" && save.p.name.length >= 1 && save.p.name.length <= 16;
    if (!ok) return res.status(400).json({ error: "Not a valid character save" });
    if (JSON.stringify(save).length > MAX_SAVE_BYTES) return res.status(413).json({ error: "Save is too large" });
    const r = await EmberAccount.updateOne({ _id: req.ember.id }, { character: save, characterSavedAt: new Date() });
    if (!r.matchedCount) return res.status(401).json({ error: "Account not found. Please log in again." });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Could not save your character" });
  }
});

router.delete("/character", requireEmbervaleAuth, async (req, res) => {
  try {
    await EmberAccount.updateOne({ _id: req.ember.id }, { character: null, characterSavedAt: null });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Could not delete the character" });
  }
});

// Error reports from players' games, and admin backups (routes/embervale/errors.js)
router.use(errorsRouter);

// Public: how many players are connected (for a landing page or the title screen).
router.get("/status", (req, res) => res.json({ online: onlineCount() }));

module.exports = router;
