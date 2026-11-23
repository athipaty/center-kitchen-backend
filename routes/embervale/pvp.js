// Embervale player fights (duels, the arena, guild war): the server decides which hits count.
// A game that knows this path sends each hit on another player here ("pvpHit") instead of straight to that
// player. The server checks that the two really are fighting (a duel both agreed to, opposite teams in a started
// arena match, rival guilds in Emberkeep during a war), that they stand in the same region within reach (from the
// positions it already relays), that the attacker isn't hitting faster than any attack can, and caps the damage for
// the attacker's level. Only then is the hit passed on ("pvpHurt"); the hurt player's game takes off their DEF as
// before. Old games keep the direct way; the game only uses this path when the server says "pvpReady".
// Every handler is wrapped so a bad message only fails that socket.
const { matchOf } = require("./arena");
const { _gw } = require("./guildwar");

const REACH = 520;           // px: a little more than the games' own 450, as positions here are a moment old
const HITS_PER_SEC = 14;     // multi-hit skills land several hits at once; nobody honest sends more than this
const KINDS = { hit: "duel", ah: "arena", gh: "gw" };
const KEEP_ZONE = "keep";

const fin = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const roomOf = (s) => String(s.data.channel || "").split(":")[0];

// are attacker a and target t allowed to hurt each other in this kind of fight?
function fighting(kind, a, t, msg) {
  if (kind === "duel") return a.data.duelWith === t.id && t.data.duelWith === a.id;
  if (kind === "arena") {
    const m = matchOf(a.id);
    if (!m || m.done || m !== matchOf(t.id) || (msg.m && msg.m !== m.id)) return false;
    if (Date.now() < m.start - 500 || m.out.has(a.id) || m.out.has(t.id)) return false;
    const ta = m.teams.findIndex((x) => x.includes(a.id)), tt = m.teams.findIndex((x) => x.includes(t.id));
    return ta >= 0 && tt >= 0 && ta !== tt;
  }
  if (kind === "gw") {
    if (!_gw.wars.has(roomOf(a)) || roomOf(a) !== roomOf(t)) return false;
    const ga = a.data.guild, gt = t.data.guild;
    return !!(ga && gt && ga.id !== gt.id && a.data.presence?.z === KEEP_ZONE && t.data.presence?.z === KEEP_ZONE);
  }
  return false;
}

function attachPvp(socket, ns) {
  const on = (ev, fn) => socket.on(ev, (msg) => { try { fn(msg && typeof msg === "object" ? msg : {}); } catch { /* ignore bad message */ } });
  let tokens = HITS_PER_SEC, last = Date.now();
  socket.data.pvpStats = { ok: 0, refused: 0 };
  socket.emit("pvpReady", { v: 1 });

  // a duel is on when both players say so (each names the other)
  on("duelOn", (msg) => { const t = ns.sockets.get(String(msg.peer || "")); socket.data.duelWith = t && t.id !== socket.id ? t.id : null; });
  on("duelOff", () => { socket.data.duelWith = null; });

  on("pvpHit", (msg) => {
    const refuse = () => { socket.data.pvpStats.refused++; };
    const now = Date.now();
    tokens = Math.min(HITS_PER_SEC, tokens + ((now - last) / 1000) * HITS_PER_SEC); last = now;
    if (tokens < 1) return refuse();
    tokens -= 1;
    const kind = KINDS[msg.k];
    const t = ns.sockets.get(String(msg.to || ""));
    if (!kind || !t || t.id === socket.id || t.data.channel !== socket.data.channel) return refuse();
    const pa = socket.data.presence, pt = t.data.presence;
    if (!pa || !pt || typeof pa.z !== "string" || pa.z !== pt.z) return refuse();
    if (Math.hypot(fin(pa.x) - fin(pt.x), fin(pa.y) - fin(pt.y)) > REACH) return refuse();
    if (!fighting(kind, socket, t, msg)) return refuse();
    // the same cap the games use (400 + 150 a level), plus room for the target's DEF they take off themselves
    const cap = 400 + clamp(Math.round(fin(pa.lv)) || 1, 1, 99) * 150 + clamp(fin(pt.df), 0, 5000) * 0.6;
    const d = clamp(Math.round(fin(msg.d)), 0, Math.round(cap));
    if (!(d > 0)) return refuse();
    socket.data.pvpStats.ok++;
    const out = { from: socket.id, k: msg.k, d, c: msg.c ? 1 : 0 };
    if (kind === "arena") out.m = String(msg.m || "").slice(0, 16);
    t.emit("pvpHurt", out);
  });

  socket.on("disconnect", () => {
    try { for (const s of ns.sockets.values()) if (s.data.duelWith === socket.id) s.data.duelWith = null; } catch { /* ignore */ }
  });
}

module.exports = { attachPvp, _pvp: { fighting, REACH, HITS_PER_SEC } };
