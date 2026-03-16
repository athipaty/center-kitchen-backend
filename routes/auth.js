const express = require("express");
const router = express.Router();
const Token = require("../models/Token");

const TOKEN_VALID_DAYS = 7;

function generateToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress
  );
}

function getTodayPassword() {
  // Thailand timezone (UTC+7)
  const now = new Date();
  const thai = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }),
  );

  const yy = String(thai.getFullYear()).slice(2); // e.g. "25"
  const mm = String(thai.getMonth() + 1).padStart(2, "0"); // e.g. "03"
  const dd = String(thai.getDate()).padStart(2, "0"); // e.g. "13"

  return `${yy}${mm}${dd}`; // e.g. "260313"
}

router.post("/login", async (req, res) => {
  try {
    const { password } = req.body;
    const ip = getClientIp(req);

    if (password !== getTodayPassword()) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    const token = generateToken();
    const expiry = Date.now() + TOKEN_VALID_DAYS * 24 * 60 * 60 * 1000;

    await Token.create({ token, ip, expiry });
    console.log(`✅ Login success from IP: ${ip}`);
    res.json({ token, expiry });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/verify", async (req, res) => {
  try {
    const { token } = req.body;
    const ip = getClientIp(req);
    const entry = await Token.findOne({ token });

    if (!entry)
      return res.status(401).json({ valid: false, reason: "Invalid token" });
    if (Date.now() > entry.expiry) {
      await Token.deleteOne({ token });
      return res.status(401).json({ valid: false, reason: "Token expired" });
    }
    if (entry.ip !== ip) {
      return res.status(401).json({ valid: false, reason: "IP mismatch" });
    }

    res.json({ valid: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
