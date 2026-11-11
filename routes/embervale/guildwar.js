// Embervale guild war: guilds fight over the Ember Crystal in Emberkeep.
// Every evening (20:00 Thailand time, 15 minutes) the war opens. The server watches where players stand:
// a guild alone in the ring around the crystal for CAPTURE_S seconds takes it; the holder scores a point a
// second; rival guilds in the ring stall a capture. The guild with the most points owns the keep until the
// next war (stored per room in ember_keeps). Fighting between players in the keep happens in their games,
// like duels; the score only depends on positions, which the server sees.
const EmberKeep = require("../../models/embervale/EmberKeep");
const { isAdmin } = require("./mod");

const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
// Test timings: EMBER_GW_FIRST_MS (first war this long after start), EMBER_GW_LEN_MS, EMBER_GW_EVERY_MS
const TEST_FIRST = num(process.env.EMBER_GW_FIRST_MS, 0);
const LEN_MS = num(process.env.EMBER_GW_LEN_MS, 15 * 60_000);
const EVERY_MS = num(process.env.EMBER_GW_EVERY_MS, 24 * 3600_000);
const CAPTURE_S = num(process.env.EMBER_GW_CAPTURE_S, 20);
const START_HOUR_TH = 20; // 20:00 in Thailand (UTC+7)
// the ring around the crystal (world pixels; matches the game's Emberkeep map)
const KEEP = { zone: "keep", x: 22.5 * 32, y: 17.5 * 32, r: 4 * 32 };

const clean = (t, n) => String(t ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, n);
const bootAt = Date.now();

// the next war window [start, end) at or after t
function windowAt(t) {
  if (TEST_FIRST) {
    const first = bootAt + TEST_FIRST, k = Math.max(0, Math.floor((t - first) / EVERY_MS));
    const s = first + k * EVERY_MS;
    return t < s + LEN_MS ? { start: s, end: s + LEN_MS } : { start: s + EVERY_MS, end: s + EVERY_MS + LEN_MS };
  }
  const day = 86400_000, th = 7 * 3600_000;
  const local = t + th, dayStart = local - (local % day);
  let s = dayStart + START_HOUR_TH * 3600_000 - th;
  if (t >= s + LEN_MS) s += day;
  return { start: s, end: s + LEN_MS };
}

const wars = new Map();   // room -> { end, holder, capture: { id, s }, points: Map(id -> { name, emblem, pts }) }
const owners = new Map(); // room -> { guildId, name, emblem } (cache of ember_keeps)
const ended = new Map();  // room -> when its last war ended (so a war ended early is not restarted by the schedule)

async function ownerOf(room) {
  if (!owners.has(room)) {
    const k = await EmberKeep.findOne({ room }).lean();
    owners.set(room, k && k.guildId ? { guildId: k.guildId, name: k.name, emblem: k.emblem } : null);
  }
  return owners.get(room);
}

const roomOf = (s) => String(s.data.channel || "").split(":")[0];
function socketsIn(ns, room) { const out = []; for (const s of ns.sockets.values()) if (s.data.channel && roomOf(s) === room) out.push(s); return out; }

function stateOf(w, now) {
  const top = [...w.points.entries()].map(([id, p]) => ({ id, name: p.name, emblem: p.emblem, pts: p.pts })).sort((a, b) => b.pts - a.pts).slice(0, 5);
  const h = w.holder && w.points.get(w.holder);
  const c = w.capture && w.points.get(w.capture.id);
  return {
    on: true, left: Math.max(0, Math.round((w.end - now) / 1000)),
    holder: h ? { id: w.holder, name: h.name, emblem: h.emblem } : null,
    capture: c ? { id: w.capture.id, name: c.name, pct: Math.min(100, Math.round((w.capture.s / CAPTURE_S) * 100)) } : null,
    contested: !!w.contested, top,
  };
}

async function finishWar(ns, room, w) {
  wars.delete(room); ended.set(room, Date.now());
  const best = [...w.points.entries()].sort((a, b) => b[1].pts - a[1].pts)[0];
  let owner = await ownerOf(room);
  if (best && best[1].pts > 0) {
    owner = { guildId: best[0], name: best[1].name, emblem: best[1].emblem };
    owners.set(room, owner);
    await EmberKeep.updateOne({ room }, { guildId: owner.guildId, name: owner.name, emblem: owner.emblem, points: best[1].pts, since: new Date() }, { upsert: true });
  }
  const msg = { k: "end", owner, pts: best ? best[1].pts : 0, next: windowAt(Date.now() + 1000).start };
  for (const s of socketsIn(ns, room)) s.emit("gwAnnounce", msg);
}

function tickRoom(ns, room, w, now) {
  // who stands in the ring: guild members who are alive, by guild
  const inRing = new Map();
  for (const s of socketsIn(ns, room)) {
    const p = s.data.presence, g = s.data.guild;
    if (!p || !g || p.z !== KEEP.zone || p.d) continue;
    if (Math.hypot((Number(p.x) || 0) - KEEP.x, (Number(p.y) || 0) - KEEP.y) > KEEP.r) continue;
    inRing.set(g.id, g);
    if (!w.points.has(g.id)) w.points.set(g.id, { name: g.name, emblem: g.emblem, pts: 0 });
  }
  w.contested = inRing.size > 1;
  if (inRing.size === 1) {
    const [gid] = inRing.keys();
    if (gid !== w.holder) {
      if (!w.capture || w.capture.id !== gid) w.capture = { id: gid, s: 0 };
      w.capture.s++;
      if (w.capture.s >= CAPTURE_S) {
        w.holder = gid; w.capture = null;
        const g = w.points.get(gid);
        for (const s of socketsIn(ns, room)) s.emit("gwAnnounce", { k: "taken", name: g.name, emblem: g.emblem });
      }
    } else w.capture = null;
  } else if (inRing.size === 0 && w.capture) {
    w.capture.s = Math.max(0, w.capture.s - 1); // an abandoned capture slowly fades
    if (!w.capture.s) w.capture = null;
  }
  if (w.holder) w.points.get(w.holder).pts++;
  const st = stateOf(w, now);
  for (const s of socketsIn(ns, room)) s.emit("gwState", st);
}

let ticking = false;
async function tick(ns) {
  if (ticking) return; ticking = true;
  try {
    const now = Date.now(), win = windowAt(now);
    const rooms = new Set();
    for (const s of ns.sockets.values()) if (s.data.channel) rooms.add(roomOf(s));
    for (const room of rooms) {
      let w = wars.get(room);
      if (!w && now >= win.start && now < win.end && !((ended.get(room) || 0) >= win.start)) w = await openWar(ns, room, win.end);
      if (!w) continue;
      if (now >= w.end) await finishWar(ns, room, w);
      else tickRoom(ns, room, w, now);
    }
    for (const [room, w] of wars) if (!rooms.has(room) && now >= w.end) wars.delete(room);
  } finally { ticking = false; }
}

async function openWar(ns, room, end) {
  const now = Date.now();
  const w = { end, holder: null, capture: null, contested: false, points: new Map() };
  wars.set(room, w);
  // last war's owner starts holding the crystal
  const o = await ownerOf(room);
  if (o) { w.holder = o.guildId; w.points.set(o.guildId, { name: o.name, emblem: o.emblem, pts: 0 }); }
  for (const s of socketsIn(ns, room)) s.emit("gwAnnounce", { k: "start", left: Math.round((w.end - now) / 1000), owner: o });
  return w;
}

function startGuildWar(ns) {
  setInterval(() => { tick(ns).catch(() => { /* never let the war clock break the game */ }); }, 1000).unref();
}

// tell a player about the keep: owner, next war, the war in progress
function attachGuildWar(socket, ns) {
  socket.on("gwInfo", async () => {
    try {
      if (!socket.data.channel) return;
      const room = roomOf(socket), now = Date.now(), w = wars.get(room);
      socket.emit("gwInfo", { owner: await ownerOf(room), next: windowAt(now).start, len: Math.round(LEN_MS / 1000), capture: CAPTURE_S, war: w ? stateOf(w, now) : null });
    } catch { /* ignore */ }
  });
}

// admins can open a war now (for an event, or to test) or end the current one early
function attachGuildWarAdmin(socket, ns) {
  socket.on("gwAdmin", async (msg) => {
    try {
      if (!isAdmin(socket) || !socket.data.channel || !msg || typeof msg !== "object") return;
      const room = roomOf(socket), w = wars.get(room);
      if (msg.act === "start" && !w) {
        const mins = Math.max(1, Math.min(60, Math.floor(Number(msg.minutes) || 15)));
        await openWar(ns, room, Date.now() + mins * 60_000);
      } else if (msg.act === "end" && w) w.end = Date.now();
    } catch { /* ignore */ }
  });
}

module.exports = { attachGuildWarAdmin, startGuildWar, attachGuildWar, KEEP, _gw: { wars, owners, windowAt } };
