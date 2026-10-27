// OneMap (Singapore Land Authority) walking routes and place search for Smoke Finder.
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

// OneMap names are in capitals ("OUR TAMPINES HUB"); show them as Title Case,
// keeping acronyms and codes ("MRT", "EW14", "#01-23") as they are.
const KEEP_CAPS = /^(MRT|LRT|HDB|NUS|NTU|SMU|SIT|SUSS|ITE|CBD|ECP|PIE|CTE|AYE|BKE|KPE|SLE|TPE|KJE|MCE|SAFRA|YMCA|YWCA|NEA|ACS|SGH|TTSH|KKH|NUH|CGH|UOB|OCBC|DBS|POSB|ESH|CC)$/;
const titleWord = (w) => {
  const core = w.replace(/[^A-Z0-9]/gi, "");
  if (KEEP_CAPS.test(core) || /\d/.test(core)) return w;
  return w.toLowerCase().replace(/(^|[-(/@&])([a-z])/g, (_, before, c) => before + c.toUpperCase());
};
const titleCase = (s) => String(s ?? "").split(" ").map(titleWord).join(" ").trim();

const SEARCH_CACHE_MS = 60 * 60_000;
const SEARCH_CACHE_MAX = 1000;
const searchCache = new Map(); // lower-case query -> { at, value }

// Places matching a name, address or postcode: [{ name, address, lat, lng }].
async function searchPlaces(query) {
  const q = query.toLowerCase();
  const hit = searchCache.get(q);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_MS) return hit.value;

  const params = new URLSearchParams({ searchVal: query, returnGeom: "Y", getAddrDetails: "Y", pageNum: "1" });
  const call = async () =>
    fetch(`${API}/common/elastic/search?${params}`, {
      // Works without a token for now, but OneMap asks for one.
      headers: configured() ? { Authorization: await token() } : {},
      signal: AbortSignal.timeout(10_000),
    });
  let res = await call();
  if (res.status === 401 && configured()) {
    tokenCache = { token: null, expiresAt: 0 };
    res = await call();
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(body.results)) throw new Error(`OneMap search failed (${res.status})`);

  const seen = new Set();
  const value = [];
  for (const r of body.results) {
    const lat = Number(r.LATITUDE);
    const lng = Number(r.LONGITUDE);
    if (!(lat > 1.15 && lat < 1.48 && lng > 103.59 && lng < 104.1)) continue;
    const name = titleCase(r.SEARCHVAL);
    const id = `${name}|${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const street = [r.BLK_NO, r.ROAD_NAME].filter((x) => x && x !== "NIL").join(" ");
    const postal = r.POSTAL && r.POSTAL !== "NIL" ? `Singapore ${r.POSTAL}` : null;
    const address = [titleCase(street), postal].filter(Boolean).join(", ") || null;
    value.push({ name, address, lat, lng });
    if (value.length === 6) break;
  }
  if (searchCache.size >= SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(q, { at: Date.now(), value });
  return value;
}

module.exports = { configured, walkRoute, searchPlaces };
