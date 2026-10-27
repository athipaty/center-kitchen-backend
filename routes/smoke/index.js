const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const SmokeZone = require("../../models/smoke/SmokeZone");
const SmokeDsa = require("../../models/smoke/SmokeDsa");

// The engine is the smoke-finder package (ESM, installed from GitHub), so it's
// loaded with a dynamic import. It only ever sees the zones near one point.
let enginePromise;
const loadEngine = () =>
  (enginePromise ??= Promise.all([import("smoke-finder/src/engine.js"), import("smoke-finder/src/geo.js")]).then(
    ([engine, geo]) => ({ ...engine, ...geo })
  ));

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

// F1: "Can I smoke here?"  GET /api/smoke/check?lat=1.3039&lng=103.8318&acc=8
router.get("/check", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const accuracyM = req.query.acc === undefined ? 0 : Number(req.query.acc);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracyM) || accuracyM < 0) {
      return res.status(400).json({ error: "lat, lng and optional acc (metres) must be numbers" });
    }
    if (lat < SG_BOUNDS.s || lat > SG_BOUNDS.n || lng < SG_BOUNDS.w || lng > SG_BOUNDS.e) {
      return res.status(400).json({ error: "Location is outside Singapore" });
    }

    // Without data every check would come back green, so refuse instead.
    const [meta, { inRings }] = await Promise.all([loadMeta(), loadEngine()]);
    if (!meta?.boundary) return res.status(503).json({ error: "Smoking-area data is not loaded yet" });
    if (!inRings(lat, lng, meta.boundary)) return res.status(400).json({ error: "Location is outside Singapore" });

    const [zones, dsas, { createChecker }] = await Promise.all([
      SmokeZone.find({ area: { $geoIntersects: { $geometry: boxAround(lat, lng, QUERY_RADIUS_M) } } })
        .select("-_id -area")
        .lean(),
      SmokeDsa.find({
        location: { $nearSphere: { $geometry: { type: "Point", coordinates: [lng, lat] }, $maxDistance: DSA_RADIUS_M } },
      })
        .select("-_id -location")
        .lean(),
      loadEngine(),
    ]);

    const check = createChecker({ zones, dsas, builtAt: meta.builtAt });
    res.json(check({ lat, lng, accuracyM }));
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
