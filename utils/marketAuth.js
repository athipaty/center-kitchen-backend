const jwt = require("jsonwebtoken");

// Market has real multi-user public accounts (buyers/sellers), unlike the
// single-shared-password admin tools elsewhere in this backend — hence its
// own JWT secret instead of the opaque Token-collection scheme in
// routes/shared/auth.js.
function getSecret() {
  return process.env.MARKET_JWT_SECRET || "dev-insecure-secret-change-me";
}

function signMarketToken(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: "30d" });
}

function requireMarketAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing authorization token" });
  }
  try {
    const token = header.slice("Bearer ".length);
    req.marketAuth = jwt.verify(token, getSecret());
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function verifyMarketToken(token) {
  return jwt.verify(token, getSecret());
}

module.exports = { signMarketToken, requireMarketAuth, verifyMarketToken };
