const express = require("express");
const router = express.Router();
const SmokeDsa = require("../../models/smoke/SmokeDsa");
const spots = require("./spots");
const {
  loadNearby,
  loadMeta,
  readPoint,
  dsasNear,
  zonesNear,
  checkPoint,
  deviceHash,
  forecastNear,
  QUERY_RADIUS_M,
} = require("./lib");

const NEARBY_SEARCH_M = 250; // how far /nearby scans for open legal spots
const NEARBY_DSA_M = 1500;
const NEARBY_DSA_LIMIT = 10;
const NEARBY_COMMUNITY_M = 1000;
const NEARBY_COMMUNITY_LIMIT = 15;

// F1: "Can I smoke here?"  GET /api/smoke/check?lat=1.3039&lng=103.8318&acc=8
router.get("/check", async (req, res) => {
  try {
    const point = await readPoint(req.query, res);
    if (!point) return;
    res.json(await checkPoint(point));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// F2: legal places near a point.  GET /api/smoke/nearby?lat=1.3039&lng=103.8318
// `dsas`: the 10 nearest NEA designated smoking areas within 1.5 km.
// `community`: spots added by users within 1 km (not hidden by reports).
// `open`: nearest open spots within 250 m where the rules allow smoking (computed, not visited).
// `weather`: NEA 2-hour forecast for the nearest area (F4), or null.
router.get("/nearby", async (req, res) => {
  try {
    const point = await readPoint(req.query, res);
    if (!point) return;
    const { lat, lng, meta, engine } = point;

    const [zones, nearDsas, dsas, community, weather, { findLegalSpots, walkMinutes }] = await Promise.all([
      zonesNear(lat, lng, NEARBY_SEARCH_M + QUERY_RADIUS_M),
      dsasNear(lat, lng, NEARBY_SEARCH_M + QUERY_RADIUS_M),
      dsasNear(lat, lng, NEARBY_DSA_M, NEARBY_DSA_LIMIT),
      spots.communityNear(lat, lng, NEARBY_COMMUNITY_M, NEARBY_COMMUNITY_LIMIT, deviceHash(req)),
      forecastNear(lat, lng),
      loadNearby(),
    ]);
    const check = engine.createChecker({ zones, dsas: nearDsas, builtAt: meta.builtAt });
    const [ox, oy] = engine.project(lat, lng);
    const withDistance = (x, y) => {
      const distanceM = Math.round(Math.hypot(x - ox, y - oy));
      return { distanceM, walkMin: walkMinutes(distanceM) };
    };

    res.json({
      dsas: dsas.map(({ x, y, ...d }) => ({ ...d, ...withDistance(x, y) })),
      community: community.map((s) => ({ ...s, ...withDistance(...engine.project(s.lat, s.lng)) })),
      open: findLegalSpots(check, { lat, lng }, { radiusM: NEARBY_SEARCH_M }),
      weather,
      searchRadiusM: NEARBY_SEARCH_M,
      dataBuiltAt: meta.builtAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// F5 / F6: community spots
router.use("/spots", spots);

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
