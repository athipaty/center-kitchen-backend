const jwt = require("jsonwebtoken");

// Embervale (browser MMO, https://ro-six-bay.vercel.app) has its own player
// accounts, so like Market it signs its own JWTs with a separate secret.
function getSecret() {
  return process.env.EMBERVALE_JWT_SECRET || "dev-insecure-secret-change-me";
}

function signEmbervaleToken(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: "60d" });
}

function verifyEmbervaleToken(token) {
  return jwt.verify(token, getSecret());
}

function requireEmbervaleAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Please log in" });
  }
  try {
    req.ember = verifyEmbervaleToken(header.slice("Bearer ".length));
    next();
  } catch {
    return res.status(401).json({ error: "Your login has expired. Please log in again." });
  }
}

module.exports = { signEmbervaleToken, verifyEmbervaleToken, requireEmbervaleAuth };
