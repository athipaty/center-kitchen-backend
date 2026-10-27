// Shared by the Smoke Finder routes (index.js, spots.js).
const crypto = require("crypto");
const axios = require("axios");
const mongoose = require("mongoose");
const SmokeZone = require("../../models/smoke/SmokeZone");
const SmokeDsa = require("../../models/smoke/SmokeDsa");

// The engine is the smoke-finder package (ESM, installed from GitHub), so it's
// loaded with a dynamic import. It only ever sees the zones near one point.
// nearby.js loads separately so a problem with it can't take down /check.
let enginePromise;
const loadEngine = () =>
  (enginePromise ??= Promise.all([import("smoke-finder/src/engine.js"), import("smoke-finder/src/geo.js")]).then(
    (modules) => Object.assign({}, ...modules)
  ));
let nearbyPromise;
const loadNearby = () => (nearbyPromise ??= import("smoke-finder/src/nearby.js"));

const SG_BOUNDS = { s: 1.15, w: 103.59, n: 1.48, e: 104.1 };
// Widest reach of any rule (Orchard NSZ amber band is 150 m) plus a margin.
const QUERY_RADIUS_M = 170;
const DSA_RADIUS_M = 50;

// Import metadata changes only when smoke-finder re-imports, so cache it briefly.
let metaCache = { at: 0, value: null };
async function loadMeta() {
  if (Date.now() - metaCache.at < 10 * 60_000) return metaCache.value;
  const value = await mongoose.connection.db.collection("smokemeta").findOne({ _id: "current" });
  metaCache = { at: Date.now(), value };
  return value;
}

function boxAround(lat, lng, metres) {
  const dLat = metres / 110574;
  const dLng = metres / (111320 * Math.cos((lat * Math.PI) / 180));
  const [w, e, s, n] = [lng - dLng, lng + dLng, lat - dLat, lat + dLat];
  return { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

// Parses lat/lng/acc (from a query string or a form body) and makes sure the
// point is in Singapore and the data is loaded. Sends the error response
// itself and returns null when the request can't go on.
async function readPoint({ lat: rawLat, lng: rawLng, acc }, res) {
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  const accuracyM = acc === undefined || acc === "" ? 0 : Number(acc);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracyM) || accuracyM < 0) {
    res.status(400).json({ error: "lat, lng and optional acc (metres) must be numbers" });
    return null;
  }
  if (lat < SG_BOUNDS.s || lat > SG_BOUNDS.n || lng < SG_BOUNDS.w || lng > SG_BOUNDS.e) {
    res.status(400).json({ error: "Location is outside Singapore" });
    return null;
  }

  // Without data every check would come back green, so refuse instead.
  const [meta, engine] = await Promise.all([loadMeta(), loadEngine()]);
  if (!meta?.boundary) {
    res.status(503).json({ error: "Smoking-area data is not loaded yet" });
    return null;
  }
  if (!engine.inRings(lat, lng, meta.boundary)) {
    res.status(400).json({ error: "Location is outside Singapore" });
    return null;
  }
  return { lat, lng, accuracyM, meta, engine };
}

// Nearest first ($nearSphere sorts by distance).
const dsasNear = (lat, lng, metres, limit = 0) =>
  SmokeDsa.find({
    location: { $nearSphere: { $geometry: { type: "Point", coordinates: [lng, lat] }, $maxDistance: metres } },
  })
    .limit(limit)
    .select("-_id -location")
    .lean();

const zonesNear = (lat, lng, metres) =>
  SmokeZone.find({ area: { $geoIntersects: { $geometry: boxAround(lat, lng, metres) } } })
    .select("-_id -area")
    .lean();

// Runs the F1 check at a point, loading only the zones it needs.
async function checkPoint({ lat, lng, accuracyM = 0, meta, engine }) {
  const [zones, dsas] = await Promise.all([zonesNear(lat, lng, QUERY_RADIUS_M), dsasNear(lat, lng, DSA_RADIUS_M)]);
  return engine.createChecker({ zones, dsas, builtAt: meta.builtAt })({ lat, lng, accuracyM });
}

// The app sends a random UUID it keeps in localStorage. Only a hash is stored,
// so a vote can't be traced back to a phone. Returns null if it's missing.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function deviceHash(req) {
  const id = req.get("X-Device-Id");
  if (!id || !UUID_RE.test(id)) return null;
  return crypto.createHash("sha256").update(`smoke-finder:${id.toLowerCase()}`).digest("hex").slice(0, 32);
}

// NEA 2-hour forecast for the area nearest the point (47 areas). Cached 10 min;
// returns null if NEA is unreachable so callers can carry on without it.
const FORECAST_URL = "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
const WET = /rain|shower|thunder/i;
let forecastCache = { at: 0, value: null };
async function forecastNear(lat, lng) {
  try {
    if (Date.now() - forecastCache.at > 10 * 60_000) {
      const { data } = await axios.get(FORECAST_URL, { timeout: 5000 });
      forecastCache = { at: Date.now(), value: data.data };
    }
    const { area_metadata: areas, items } = forecastCache.value;
    const nearest = areas.reduce((best, a) => {
      const d = Math.hypot(a.label_location.latitude - lat, a.label_location.longitude - lng);
      return !best || d < best.d ? { name: a.name, d } : best;
    }, null);
    const item = items[0];
    const forecast = item.forecasts.find((f) => f.area === nearest.name)?.forecast ?? null;
    return { area: nearest.name, forecast, raining: WET.test(forecast ?? ""), period: item.valid_period?.text ?? null };
  } catch (err) {
    console.error("smoke: forecast unavailable:", err.message);
    return null;
  }
}

module.exports = {
  loadEngine,
  loadNearby,
  loadMeta,
  readPoint,
  dsasNear,
  zonesNear,
  checkPoint,
  deviceHash,
  forecastNear,
  QUERY_RADIUS_M,
};
