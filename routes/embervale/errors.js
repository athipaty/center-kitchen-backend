// Embervale error log and backups.
//  POST /errors        a player's game reports a script error (no login needed; rate-limited; grouped by place)
//  GET  /admin/backup  admins download every account's character, guilds, reports and keep owners as one JSON file
// Admins (EMBERVALE_ADMINS) read and clear the error list from the Admin window (socket events in attachErrors).
const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const EmberError = require("../../models/embervale/EmberError");
const EmberAccount = require("../../models/embervale/EmberAccount");
const EmberGuild = require("../../models/embervale/EmberGuild");
const EmberReport = require("../../models/embervale/EmberReport");
const EmberKeep = require("../../models/embervale/EmberKeep");
const { verifyEmbervaleToken, requireEmbervaleAuth } = require("../../utils/embervaleAuth");
const { isAdminName, isAdmin } = require("./mod");

const router = express.Router();
const KEEP_ROWS = 300;
const clean = (t, n) => String(t ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").trim().slice(0, n);
const errLimiter = rateLimit({ windowMs: 10 * 60_000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Too many reports" } });

let writes = 0;
router.post("/errors", errLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const msg = clean(b.msg, 300);
    if (!msg) return res.status(400).json({ error: "No message" });
    // only the file name of the script, never a full URL with query strings
    const src = clean(String(b.src || "").split("?")[0].split("/").pop(), 80);
    const line = Math.max(0, Math.min(1e6, Math.floor(Number(b.line) || 0)));
    const col = Math.max(0, Math.min(1e6, Math.floor(Number(b.col) || 0)));
    let user = "guest";
    const h = req.headers.authorization;
    if (h && h.startsWith("Bearer ")) { try { user = verifyEmbervaleToken(h.slice(7)).username; } catch { /* expired: guest */ } }
    const key = crypto.createHash("sha1").update(`${msg}|${src}|${line}`).digest("hex");
    const now = new Date();
    await EmberError.updateOne({ key }, {
      $set: { msg, src, line, col, stack: clean(b.stack, 1500), version: clean(b.v, 16), ua: clean(req.headers["user-agent"], 160), user, last: now },
      $setOnInsert: { first: now }, $inc: { count: 1 },
    }, { upsert: true });
    // keep the collection small: every so often drop all but the most recent rows
    if (++writes % 25 === 0) {
      const old = await EmberError.find({}, { _id: 1 }).sort({ last: -1 }).skip(KEEP_ROWS).lean();
      if (old.length) await EmberError.deleteMany({ _id: { $in: old.map((o) => o._id) } });
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Could not save" });
  }
});

router.get("/admin/backup", requireEmbervaleAuth, async (req, res) => {
  try {
    if (!isAdminName(req.ember.username)) return res.status(403).json({ error: "Admins only" });
    const [accounts, guilds, reports, keeps] = await Promise.all([
      EmberAccount.find({}, { passwordHash: 0 }).lean(), // never include password hashes
      EmberGuild.find({}).lean(), EmberReport.find({}).lean(), EmberKeep.find({}).lean(),
    ]);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Disposition", `attachment; filename="embervale-backup-${stamp}.json"`);
    res.json({ game: "embervale", at: new Date(), counts: { accounts: accounts.length, guilds: guilds.length, reports: reports.length, keeps: keeps.length }, accounts, guilds, reports, keeps });
  } catch {
    res.status(500).json({ error: "Could not make the backup" });
  }
});

// Admin window: the error list
function attachErrors(socket) {
  socket.on("modErrors", async (msg) => {
    try {
      if (!isAdmin(socket)) return;
      if (msg && msg.clear === "all") await EmberError.deleteMany({});
      else if (msg && typeof msg.clear === "string" && /^[a-f0-9]{40}$/.test(msg.clear)) await EmberError.deleteOne({ key: msg.clear });
      const rows = await EmberError.find({}).sort({ last: -1 }).limit(60).lean();
      socket.emit("modErrors", { rows: rows.map((r) => ({ key: r.key, msg: r.msg, src: r.src, line: r.line, col: r.col, stack: r.stack, v: r.version, ua: r.ua, user: r.user, count: r.count, first: r.first, last: r.last })) });
    } catch { /* ignore */ }
  });
}

module.exports = { errorsRouter: router, attachErrors };
