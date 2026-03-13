const express = require("express");
const router = express.Router();

const PASSWORD = process.env.APP_PASSWORD || "admin123";
const TOKEN_VALID_DAYS = 7;

// Simple in-memory store { token: { ip, expiry } }
// For production use MongoDB instead
const validTokens = {};

function generateToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
}

// POST /auth/login
router.post("/login", (req, res) => {
  const { password } = req.body;
  const ip = getClientIp(req);

  if (password !== PASSWORD) {
    return res.status(401).json({ message: "Incorrect password" });
  }

  const token = generateToken();
  const expiry = Date.now() + TOKEN_VALID_DAYS * 24 * 60 * 60 * 1000;
  validTokens[token] = { ip, expiry };

  console.log(`✅ Login from IP: ${ip}`);
  res.json({ token, expiry });
});

// POST /auth/verify
router.post("/verify", (req, res) => {
  const { token } = req.body;
  const ip = getClientIp(req);
  const entry = validTokens[token];

  if (!entry) return res.status(401).json({ valid: false, reason: "Invalid token" });
  if (Date.now() > entry.expiry) {
    delete validTokens[token];
    return res.status(401).json({ valid: false, reason: "Token expired" });
  }
  if (entry.ip !== ip) {
    return res.status(401).json({ valid: false, reason: "IP mismatch" });
  }

  res.json({ valid: true });
});

module.exports = router;