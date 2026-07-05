const express   = require("express");
const crypto    = require("crypto");
const rateLimit = require("express-rate-limit");
const router    = express.Router();
const Token     = require("../../models/shared/Token");

const TOKEN_VALID_DAYS = 7;

// Password guessing is otherwise unbounded — cap attempts per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts — try again later" },
});

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress
  );
}

function getTodayPassword() {
  return process.env.ADMIN_PASSWORD || "555";
}

router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    const ip = getClientIp(req);

    if (password !== getTodayPassword()) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    const token = generateToken();
    const expiry = Date.now() + TOKEN_VALID_DAYS * 24 * 60 * 60 * 1000;

    await Token.create({ token, ip, expiry });
    console.log(`âœ… Login success from IP: ${ip}`);
    res.json({ token, expiry });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/verify", async (req, res) => {
  try {
    const { token } = req.body;
    const entry = await Token.findOne({ token });

    if (!entry)
      return res.status(401).json({ valid: false, reason: "Invalid token" });
    if (Date.now() > entry.expiry) {
      await Token.deleteOne({ token });
      return res.status(401).json({ valid: false, reason: "Token expired" });
    }

    res.json({ valid: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;

