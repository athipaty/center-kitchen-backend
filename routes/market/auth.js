const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const MarketUser = require("../../models/market/MarketUser");
const { signMarketToken, requireMarketAuth } = require("../../utils/marketAuth");

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts — try again later" },
});

function toPublicUser(user) {
  const [lng, lat] = user.location?.coordinates ?? [null, null];
  return {
    id: user._id,
    email: user.email,
    name: user.name,
    lat,
    lng,
    locationName: user.locationName,
    createdAt: user.createdAt,
  };
}

function toLocation(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number") return undefined;
  return { type: "Point", coordinates: [lng, lat] };
}

router.post("/register", async (req, res) => {
  try {
    const { email, password, name, lat, lng, locationName } = req.body;
    if (!email || !password || password.length < 8 || !name) {
      return res.status(400).json({ error: "email, name, and a password of at least 8 characters are required" });
    }

    const existing = await MarketUser.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await MarketUser.create({
      email,
      passwordHash,
      name,
      location: toLocation(lat, lng),
      locationName,
    });

    const token = signMarketToken({ userId: user._id.toString(), email: user.email });
    res.status(201).json({ token, user: toPublicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const user = await MarketUser.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid email or password" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });

    const token = signMarketToken({ userId: user._id.toString(), email: user.email });
    res.json({ token, user: toPublicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/me", requireMarketAuth, async (req, res) => {
  try {
    const user = await MarketUser.findById(req.marketAuth.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/me/location", requireMarketAuth, async (req, res) => {
  try {
    const { lat, lng, locationName } = req.body;
    const location = toLocation(lat, lng);
    if (!location) return res.status(400).json({ error: "lat and lng are required" });

    const user = await MarketUser.findByIdAndUpdate(
      req.marketAuth.userId,
      { location, ...(locationName !== undefined ? { locationName } : {}) },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
