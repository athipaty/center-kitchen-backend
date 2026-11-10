// Embervale live play: a presence relay on its own socket.io namespace.
// Each player sends one small "presence" object (position, chat, emotes, monster
// state from that region's host player...). The server keeps the latest one per
// player and forwards changes to everyone in the same room + channel.
// Busy rooms split into channels of CHANNEL_CAP players.
//
// Like routes/market/chatSocket.js, every handler is wrapped so a bad message can
// only fail that socket, never crash this shared backend.
const { verifyEmbervaleToken } = require("../../utils/embervaleAuth");
const { ZoneSim, hasSim } = require("./sim");

const CHANNEL_CAP = 40;
const MAX_PRESENCE_BYTES = 12_000;
const MAX_MSGS_PER_SEC = 20;

// "room:channel" -> Set of socket ids
const channels = new Map();
let nsRef = null;
// "room:channel|region" -> { sim, idle } : server-run monsters, one per region that has players
const sims = new Map();
const TICK_MS = 100;

function ensureSim(key, zone) {
  let s = sims.get(key);
  if (!s && hasSim(zone)) { s = { sim: new ZoneSim(zone), zone, idle: 0 }; sims.set(key, s); }
  return s;
}

const cleanRoom = (r) => String(r ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || "world";

function pickChannel(room) {
  for (let n = 1; n < 1000; n++) {
    const key = `${room}:${n}`;
    const set = channels.get(key);
    if (!set || set.size < CHANNEL_CAP) return { key, n };
  }
  return { key: `${room}:1000`, n: 1000 };
}

function onlineCount() {
  let n = 0;
  for (const set of channels.values()) n += set.size;
  return n;
}

function attachEmbervale(io) {
  const ns = io.of("/embervale");
  nsRef = ns;

  // Run every active region's monsters and send each region its state ~10 times a second.
  setInterval(() => {
    for (const [key, s] of sims) {
      try {
        const ids = ns.adapter.rooms.get(key);
        const players = [];
        if (ids) for (const sid of ids) {
          const p = ns.sockets.get(sid)?.data.presence;
          if (p) players.push({ id: String(p.id || sid).slice(0, 16), x: Number(p.x) || 0, y: Number(p.y) || 0, dead: !!p.d });
        }
        if (!players.length) { s.idle += TICK_MS; if (s.idle > 60_000) sims.delete(key); continue; }
        s.idle = 0;
        s.sim.tick(TICK_MS / 1000, players);
        ns.to(key).emit("mobs", { z: s.zone, mb: s.sim.snapshot(), ev: s.sim.evs });
      } catch (err) {
        sims.delete(key); // a broken region restarts fresh next time someone is there
      }
    }
  }, TICK_MS).unref();

  // Logging in is optional: guests can play too (their progress stays on their device).
  ns.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    socket.data.username = null;
    if (token) {
      try { socket.data.username = verifyEmbervaleToken(token).username; } catch { /* expired token: play as guest */ }
    }
    next();
  });

  ns.on("connection", (socket) => {
    const peerInfo = () => ({ peer: socket.id, presence: socket.data.presence || null, guest: !socket.data.username });
    let tokens = MAX_MSGS_PER_SEC, last = Date.now();

    const leave = () => {
      const key = socket.data.channel;
      if (!key) return;
      const set = channels.get(key);
      if (set) { set.delete(socket.id); if (!set.size) channels.delete(key); }
      socket.leave(key);
      socket.to(key).emit("left", { peer: socket.id });
      socket.data.channel = null;
      if (socket.data.zoneRoom) socket.leave(socket.data.zoneRoom);
      socket.data.zone = socket.data.zoneRoom = null;
    };

    socket.on("join", (msg) => {
      try {
        leave();
        const { key, n } = pickChannel(cleanRoom(msg?.room));
        if (!channels.has(key)) channels.set(key, new Set());
        channels.get(key).add(socket.id);
        socket.data.channel = key;
        socket.join(key);
        const peers = [];
        for (const id of channels.get(key)) {
          if (id === socket.id) continue;
          const s = ns.sockets.get(id);
          if (s && s.data.presence) peers.push({ peer: id, presence: s.data.presence, guest: !s.data.username });
        }
        socket.emit("joined", { channel: n, peers, account: socket.data.username, sim: true });
      } catch (err) {
        socket.emit("error", { error: "Could not join" });
      }
    });

    socket.on("presence", (presence) => {
      try {
        const now = Date.now();
        tokens = Math.min(MAX_MSGS_PER_SEC, tokens + ((now - last) / 1000) * MAX_MSGS_PER_SEC);
        last = now;
        if (tokens < 1) return; // too chatty: drop
        tokens -= 1;
        if (!socket.data.channel || !presence || typeof presence !== "object" || Array.isArray(presence)) return;
        if (JSON.stringify(presence).length > MAX_PRESENCE_BYTES) return;
        socket.data.presence = presence;
        socket.to(socket.data.channel).emit("peer", peerInfo());

        // keep the socket in a per-region room so it gets that region's monster updates
        const zone = typeof presence.z === "string" ? presence.z.slice(0, 16) : null;
        if (zone !== socket.data.zone) {
          if (socket.data.zoneRoom) socket.leave(socket.data.zoneRoom);
          socket.data.zone = zone;
          socket.data.zoneRoom = zone && hasSim(zone) ? `${socket.data.channel}|${zone}` : null;
          socket.data.hxSeen = 0;
          if (socket.data.zoneRoom) { socket.join(socket.data.zoneRoom); ensureSim(socket.data.zoneRoom, zone); }
        }
        // hits this player reports on the server's monsters
        const s = socket.data.zoneRoom && sims.get(socket.data.zoneRoom);
        if (s && Array.isArray(presence.hx)) {
          const who = { id: String(presence.id || socket.id).slice(0, 16), x: Number(presence.x) || 0, y: Number(presence.y) || 0, lv: presence.lv };
          for (const h of presence.hx.slice(-24)) {
            if (!h || typeof h !== "object") continue;
            const i = Number(h.i);
            if (!(i > (socket.data.hxSeen || 0))) continue;
            socket.data.hxSeen = i;
            s.sim.hit(who, h);
          }
        }
      } catch {
        /* ignore bad presence */
      }
    });

    socket.on("disconnect", () => {
      try { leave(); } catch { /* ignore */ }
    });
  });
}

module.exports = { attachEmbervale, onlineCount };
