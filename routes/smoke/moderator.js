// Who is a Smoke Finder moderator: a valid token from POST /api/smoke/admin/login.
// Separate from admin.js so spots.js can use it too (admin.js already needs spots.js).
const jwt = require("jsonwebtoken");

const TOKEN_AUDIENCE = "smoke-finder";

const configured = () => !!(process.env.SMOKE_ADMIN_PASSWORD && process.env.SMOKE_JWT_SECRET);

// "unconfigured" | "missing" | "invalid" | "ok"
function moderatorStatus(req) {
  if (!configured()) return "unconfigured";
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return "missing";
  try {
    jwt.verify(header.slice(7), process.env.SMOKE_JWT_SECRET, { audience: TOKEN_AUDIENCE });
    return "ok";
  } catch {
    return "invalid";
  }
}

const isModerator = (req) => moderatorStatus(req) === "ok";

module.exports = { TOKEN_AUDIENCE, configured, moderatorStatus, isModerator };
