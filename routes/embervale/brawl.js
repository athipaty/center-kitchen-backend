// Embervale open arena (game v1.49.1+): no queue. Anyone may walk into the arena and fight anyone else inside, up to
// BRAWL_CAP players per channel. The server keeps who is inside ("brawlJoin" asks for a place, "brawlLeave" or
// leaving the arena region gives it back) and player-fight hits of kind "fa" only count between two players inside
// (see pvp.js). Every handler is wrapped so a bad message only fails that socket.
const BRAWL_CAP = 20;
const ZONE = "arena";
const inside = new Map(); // channel -> Set of socket ids

function setOf(ch) { let s = inside.get(ch); if (!s) { s = new Set(); inside.set(ch, s); } return s; }
// drop sockets that left, disconnected or walked out of the arena
function tidy(ns, ch) {
  const s = inside.get(ch); if (!s) return;
  for (const id of s) { const k = ns.sockets.get(id); if (!k || k.data.channel !== ch || (k.data.presence && k.data.presence.z && k.data.presence.z !== ZONE && Date.now() - (k.data.brawlAt || 0) > 15000)) s.delete(id); }
  if (!s.size) inside.delete(ch);
}
function brawlIn(ns, a, t) {
  const ch = a.data.channel; if (!ch || ch !== t.data.channel) return false;
  const s = inside.get(ch);
  return !!(s && s.has(a.id) && s.has(t.id) && a.data.presence?.z === ZONE && t.data.presence?.z === ZONE);
}

function attachBrawl(socket, ns) {
  const on = (ev, fn) => socket.on(ev, (msg) => { try { fn(msg && typeof msg === "object" ? msg : {}); } catch { /* ignore bad message */ } });
  const info = (extra) => { const ch = socket.data.channel; if (ch) tidy(ns, ch); const s = ch && inside.get(ch);
    socket.emit("brawlInfo", { n: s ? s.size : 0, cap: BRAWL_CAP, in: !!(s && s.has(socket.id)), ...(extra || {}) }); };
  on("brawlInfo", () => info());
  on("brawlJoin", () => {
    const ch = socket.data.channel; if (!ch) { info({ ok: false, why: "Join the game first." }); return; }
    tidy(ns, ch); const s = setOf(ch);
    if (!s.has(socket.id) && s.size >= BRAWL_CAP) { info({ ok: false, why: `The arena is full (${BRAWL_CAP} fighters). Try again in a moment.` }); return; }
    s.add(socket.id); socket.data.brawlAt = Date.now(); info({ ok: true });
  });
  on("brawlLeave", () => { const s = inside.get(socket.data.channel); if (s) s.delete(socket.id); info(); });
  socket.on("disconnect", () => { try { for (const s of inside.values()) s.delete(socket.id); } catch { /* ignore */ } });
}

module.exports = { attachBrawl, brawlIn, BRAWL_CAP, _brawl: { inside, tidy } };
