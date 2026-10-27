const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const SmokeZone = require("../../models/smoke/SmokeZone");
const SmokeDsa = require("../../models/smoke/SmokeDsa");

// The engine is the smoke-finder package (ESM, installed from GitHub), so it's
// loaded with a dynamic import. It only ever sees the zones near one point.
let enginePromise;
const loadEngine = () =>
  (enginePromise ??= Promise.all([
    import("smoke-finder/src/engine.js"),
    import("smoke-finder/src/geo.js"),
    import("smoke-finder/src/nearby.js"),
  ]).then((modules) => Object.assign({}, ...modules)));

const SG_BOUNDS = { s: 1.15, w: 103.59, n: 1.48, e: 104.1 };
// Widest reach of any rule (Orchard NSZ amber band is 150 m) plus a margin.
const QUERY_RADIUS_M = 170;
const DSA_RADIUS_M = 50;
const NEARBY_SEARCH_M = 250; // how far /nearby scans for open legal spots
const NEARBY_DSA_M = 1500;
const NEARBY_DSA_LIMIT = 10;

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

// Parses lat/lng/acc and makes sure the point is in Singapore and data is loaded.
// Sends the error response itself and returns null when the request can't go on.
async function readPoint(req, res) {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const accuracyM = req.query.acc === undefined ? 0 : Number(req.query.acc);
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

// F1: "Can I smoke here?"  GET /api/smoke/check?lat=1.3039&lng=103.8318&acc=8
router.get("/check", async (req, res) => {
  try {
    const point = await readPoint(req, res);
    if (!point) return;
    const { lat, lng, accuracyM, meta, engine } = point;

    const [zones, dsas] = await Promise.all([zonesNear(lat, lng, QUERY_RADIUS_M), dsasNear(lat, lng, DSA_RADIUS_M)]);
    const check = engine.createChecker({ zones, dsas, builtAt: meta.builtAt });
    res.json(check({ lat, lng, accuracyM }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// F2: legal places near a point.  GET /api/smoke/nearby?lat=1.3039&lng=103.8318
// `dsas`: the 10 nearest NEA designated smoking areas within 1.5 km.
// `open`: nearest open spots within 250 m where the rules allow smoking (computed, not visited).
router.get("/nearby", async (req, res) => {
  try {
    const point = await readPoint(req, res);
    if (!point) return;
    const { lat, lng, meta, engine } = point;

    const [zones, nearDsas, dsas] = await Promise.all([
      zonesNear(lat, lng, NEARBY_SEARCH_M + QUERY_RADIUS_M),
      dsasNear(lat, lng, NEARBY_SEARCH_M + QUERY_RADIUS_M),
      dsasNear(lat, lng, NEARBY_DSA_M, NEARBY_DSA_LIMIT),
    ]);
    const check = engine.createChecker({ zones, dsas: nearDsas, builtAt: meta.builtAt });
    const [ox, oy] = engine.project(lat, lng);

    res.json({
      dsas: dsas.map(({ x, y, ...d }) => {
        const distanceM = Math.round(Math.hypot(x - ox, y - oy));
        return { ...d, distanceM, walkMin: engine.walkMinutes(distanceM) };
      }),
      open: engine.findLegalSpots(check, { lat, lng }, { radiusM: NEARBY_SEARCH_M }),
      searchRadiusM: NEARBY_SEARCH_M,
      dataBuiltAt: meta.builtAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All NEA designated smoking areas, for the map.
router.get("/dsas", async (req, res) => {
  try {
    const dsas = await SmokeDsa.find().select("-_id -location -x -y").sort({ name: 1 }).lean();
    res.json(dsas);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// When the data was built and imported, and how many zones of each kind.
router.get("/meta", async (req, res) => {
  try {
    const meta = await loadMeta();
    if (!meta) return res.status(503).json({ error: "Smoking-area data is not loaded yet" });
    const { boundary, ...rest } = meta;
    res.json(rest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
