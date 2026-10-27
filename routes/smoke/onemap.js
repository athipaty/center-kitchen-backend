// OneMap (Singapore Land Authority) walking routes for Smoke Finder.
// Needs ONEMAP_EMAIL and ONEMAP_PASSWORD (a free OneMap API account). Tokens
// last 3 days and don't renew themselves, so a new one is fetched before expiry.
const API = "https://www.onemap.gov.sg/api";
const ROUTE_CACHE_MS = 24 * 3_600_000;
const ROUTE_CACHE_MAX = 2000;

const configured = () => Boolean(process.env.ONEMAP_EMAIL && process.env.ONEMAP_PASSWORD);

let tokenCache = { token: null, expiresAt: 0 };
let tokenPromise = null;

async function token() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  tokenPromise ??= (async () => {
    try {
      const res = await fetch(`${API}/auth/post/getToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: process.env.ONEMAP_EMAIL, password: process.env.ONEMAP_PASSWORD }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.access_token) throw new Error(`OneMap login failed (${res.status})`);
      // Renew an hour early so a request never goes out with a token about to expire.
      tokenCache = { token: body.access_token, expiresAt: Number(body.expiry_timestamp) * 1000 - 3_600_000 };
      return tokenCache.token;
    } finally {
      tokenPromise = null;
    }
  })();
  return tokenPromise;
}

const routeCache = new Map(); // "lat,lng>lat,lng" -> { at, value }
const key = (a, b) => `${a.lat.toFixed(5)},${a.lng.toFixed(5)}>${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;

let polylinePromise;
const loadPolyline = () => (polylinePromise ??= import("smoke-finder/src/polyline.js"));

// Resolves { seconds, metres, path: [[lat, lng], ...] }.
async function walkRoute(from, to) {
  const k = key(from, to);
  const hit = routeCache.get(k);
  if (hit && Date.now() - hit.at < ROUTE_CACHE_MS) return hit.value;

  const params = new URLSearchParams({ start: `${from.lat},${from.lng}`, end: `${to.lat},${to.lng}`, routeType: "walk" });
  const call = async () =>
    fetch(`${API}/public/routingsvc/route?${params}`, {
      headers: { Authorization: await token() },
      signal: AbortSignal.timeout(10_000),
    });
  let res = await call();
  if (res.status === 401) {
    tokenCache = { token: null, expiresAt: 0 }; // token revoked early: log in again once
    res = await call();
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.route_summary) throw new Error(`OneMap routing failed (${res.status}): ${body.status_message ?? body.error ?? ""}`);

  const { decodePolyline } = await loadPolyline();
  const value = {
    seconds: body.route_summary.total_time,
    metres: body.route_summary.total_distance,
    path: body.route_geometry ? decodePolyline(body.route_geometry) : [],
  };
  if (routeCache.size >= ROUTE_CACHE_MAX) routeCache.delete(routeCache.keys().next().value); // drop the oldest
  routeCache.set(k, { at: Date.now(), value });
  return value;
}

module.exports = { configured, walkRoute };
