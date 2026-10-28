const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const SmokeDsa = require("../../models/smoke/SmokeDsa");
const spots = require("./spots");
const stats = require("./stats");
const onemap = require("./onemap");
const checkins = require("./checkins");
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

// Location endpoints take POST with a JSON body, so locations stay out of the
// URL and therefore out of request logs. GET with query parameters still works
// for app versions that are already open on people's phones.
const params = (req) => (req.method === "POST" ? req.body ?? {} : req.query);
const getOrPost = (path, handler) => router.route(path).get(handler).post(handler);

// F1: "Can I smoke here?"  POST /api/smoke/check {"lat":1.3039,"lng":103.8318,"acc":8}
getOrPost("/check", async (req, res) => {
  try {
    const point = await readPoint(params(req), res);
    if (!point) return;
    res.json(await checkPoint(point));
    stats.count("checks");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// F2: legal places near a point.  POST /api/smoke/nearby {"lat":1.3039,"lng":103.8318}
// `dsas`: the 10 nearest NEA designated smoking areas within 1.5 km.
// `community`: spots added by users within 1 km (not hidden by reports).
// `open`: nearest open spots within 250 m where the rules allow smoking (computed, not visited).
// `weather`: NEA 2-hour forecast for the nearest area (F4), or null.
getOrPost("/nearby", async (req, res) => {
  try {
    const point = await readPoint(params(req), res);
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

    // How many people checked in at each spot in the last hour ("busy now").
    const busy = await checkins.busyFor([...dsas.map((d) => checkins.dsaKey(d.neaId)), ...community.map((s) => checkins.communityKey(s.id))]);

    res.json({
      dsas: dsas.map(({ x, y, ...d }) => ({ ...d, ...withDistance(x, y), busyNow: busy[checkins.dsaKey(d.neaId)] ?? 0 })),
      community: community.map((s) => ({ ...s, ...withDistance(...engine.project(s.lat, s.lng)), busyNow: busy[checkins.communityKey(s.id)] ?? 0 })),
      open: findLegalSpots(check, { lat, lng }, { radiusM: NEARBY_SEARCH_M }),
      weather,
      searchRadiusM: NEARBY_SEARCH_M,
      dataBuiltAt: meta.builtAt,
    });
    stats.count("nearby");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Map data around a point, so the app can answer "Can I smoke here?" without
// signal (it runs the same engine on the phone). A check looks QUERY_RADIUS_M
// around the point, so this area gives correct answers within
// AREA_RADIUS_M - QUERY_RADIUS_M of the centre. POST /api/smoke/area {"lat":..,"lng":..}
const AREA_RADIUS_M = 400;
const areaLimiter = rateLimit({ windowMs: 60 * 60_000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Too many map downloads. Try again later." } });
router.post("/area", areaLimiter, async (req, res) => {
  try {
    const point = await readPoint(params(req), res);
    if (!point) return;
    const [zones, dsas] = await Promise.all([zonesNear(point.lat, point.lng, AREA_RADIUS_M), dsasNear(point.lat, point.lng, AREA_RADIUS_M)]);
    res.json({ lat: point.lat, lng: point.lng, radiusM: AREA_RADIUS_M, usableM: AREA_RADIUS_M - QUERY_RADIUS_M, builtAt: point.meta.builtAt, zones, dsas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Walking route between two points in Singapore (OneMap).
// POST /api/smoke/route {"from":"1.3039,103.8318","to":"1.3040,103.8350"}
const MAX_ROUTE_M = 5000;
const parsePoint = (s) => {
  const [lat, lng] = String(s ?? "").split(",").map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat > 1.15 && lat < 1.48 && lng > 103.59 && lng < 104.1 ? { lat, lng } : null;
};
getOrPost("/route", async (req, res) => {
  try {
    if (!onemap.configured()) return res.status(503).json({ error: "Walking routes are not set up yet" });
    const from = parsePoint(params(req).from);
    const to = parsePoint(params(req).to);
    if (!from || !to) return res.status(400).json({ error: "from and to must be lat,lng points in Singapore" });
    const straight = Math.hypot((to.lng - from.lng) * 111320 * Math.cos((from.lat * Math.PI) / 180), (to.lat - from.lat) * 110574);
    if (straight > MAX_ROUTE_M) return res.status(400).json({ error: "Points are too far apart for a walking route" });
    const route = await onemap.walkRoute(from, to);
    res.json({ minutes: Math.max(1, Math.round(route.seconds / 60)), metres: Math.round(route.metres), path: route.path });
  } catch (err) {
    console.error("smoke: route failed:", err.message);
    res.status(502).json({ error: "Couldn't get a walking route right now" });
  }
});

// Places by name, address or postcode (OneMap), to see spots near somewhere
// before going. POST /api/smoke/search {"q":"tampines hub"}; the words stay out of the URL.
const searchLimiter = rateLimit({ windowMs: 60_000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: "Too many searches. Try again in a minute." } });
router.post("/search", searchLimiter, async (req, res) => {
  try {
    const q = String(req.body?.q ?? "").replace(/\s+/g, " ").trim();
    if (q.length < 2 || q.length > 80) return res.status(400).json({ error: "Type 2 to 80 characters" });
    res.json({ results: await onemap.searchPlaces(q) });
    stats.count("searches");
  } catch (err) {
    console.error("smoke: search failed:", err.message);
    res.status(502).json({ error: "Couldn't search right now" });
  }
});

// App opened today (once a day per device): for weekly actives and retention.
router.post("/ping", async (req, res) => {
  try {
    const device = deviceHash(req);
    if (!device) return res.status(400).json({ error: "Missing device id" });
    await stats.ping(device);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// F5 / F6: community spots
router.use("/spots", spots);

// App error reports (shown in Moderation)
router.use("/errors", require("./errors"));

// "I'm here now" check-ins for the busy-now level
router.use("/checkins", checkins);

// Moderation (password-protected)
router.use("/admin", require("./admin"));

// Opt-in push alerts for saved spots
router.use("/alerts", require("./alerts"));

// "Report a problem" from the app
router.use("/reports", require("./reports"));

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
