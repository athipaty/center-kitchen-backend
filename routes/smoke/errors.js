// App error reports (instead of a crash-reporting service). POST /api/smoke/errors
// { message, stack?, page?, version? }. Same kind of error = one document with a
// count, so a broken release can't fill the database.
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const SmokeError = require("../../models/smoke/SmokeError");

const router = express.Router();

const reportLimiter = rateLimit({ windowMs: 10 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many error reports" } });

const text = (v, max) => String(v ?? "").replace(/\s+$/g, "").slice(0, max);

// "Chrome Android", "Safari iOS": enough to reproduce, not enough to identify anyone.
function browserOf(ua = "") {
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : "other";
  const name = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "other";
  return `${name} ${os}`;
}

router.post("/", reportLimiter, async (req, res) => {
  try {
    const message = text(req.body?.message, 300);
    if (!message) return res.status(400).json({ error: "message is required" });
    const stack = text(req.body?.stack, 2000);
    const page = text(req.body?.page, 60).split(/[?#]/)[0] || "/"; // path only
    const version = text(req.body?.version, 40);
    const firstLine = stack.split("\n").find((l) => l.includes("at ") || l.includes("@")) ?? "";
    // Bundle file names change every release; group by the function, not the file.
    const where = firstLine.replace(/https?:\/\/\S+/g, "").trim();
    const id = crypto.createHash("sha256").update(`${message}|${where}`).digest("hex").slice(0, 24);

    const doc = await SmokeError.findOneAndUpdate(
      { _id: id },
      {
        $setOnInsert: { message, stack, firstAt: new Date() },
        $set: { lastAt: new Date() },
        $inc: { count: 1 },
      },
      { upsert: true, new: true }
    ).lean();
    // Remember a few distinct pages, versions and browsers.
    const extra = {};
    for (const [field, value] of [["pages", page], ["versions", version], ["browsers", browserOf(req.get("User-Agent"))]]) {
      if (value && !doc[field].includes(value) && doc[field].length < 5) extra[field] = value;
    }
    if (Object.keys(extra).length) await SmokeError.updateOne({ _id: id }, { $addToSet: extra });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
