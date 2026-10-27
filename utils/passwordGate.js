const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

// Compares a typed password with the expected one in constant time, so the
// response time doesn't hint at how many characters were right. Hashing first
// makes both sides the same length, which timingSafeEqual needs.
function passwordMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Caps password guesses per IP. Each route gets its own counter.
function passwordLimiter() {
  return rateLimit({
    windowMs: 15 * 60_000,
    max: 8,
    skipSuccessfulRequests: true, // only wrong passwords count
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many login attempts — try again later" },
  });
}

module.exports = { passwordMatches, passwordLimiter };
