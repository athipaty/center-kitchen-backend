// Embervale live play: a presence relay on its own socket.io namespace.
// Each player sends one small "presence" object (position, chat, emotes, monster
// state from that region's host player...). The server keeps the latest one per
// player and forwards changes to everyone in the same room + channel.
// Busy rooms split into channels of CHANNEL_CAP players.
//
// Like routes/market/chatSocket.js, every handler is wrapped so a bad message can
// only fail that socket, never crash this shared backend.
const { verifyEmbervaleToken } = require("../../utils/embervaleAuth");
const { ZoneSim, hasSim, WORLD_BOSSES, MOBS } = require("./sim");
const { attachSocial, getParty } = require("./social");
const { attachTrade } = require("./trade");
const { attachGuild } = require("./guild");
const { attachMod, loadModeration, filterPresenceChat } = require("./mod");
const { attachArena } = require("./arena");
const { startGuildWar, attachGuildWar, attachGuildWarAdmin } = require("./guildwar");
const { attachErrors } = require("./errors");

const CHANNEL_CAP = 40;
const MAX_PRESENCE_BYTES = 12_000;
const MAX_MSGS_PER_SEC = 20;

// "room:channel" -> Set of socket ids
const channels = new Map();
let nsRef = null;
// "room:channel|region" -> { sim, idle } : server-run monsters, one per region that has players
const sims = new Map();
const TICK_MS = 100;
// Presence relay: players in the same region get every update; the rest of the channel gets a slim copy
// (no hits, monsters or ground loot) at most once a second, or at once when something they show changes.
const FAR_EVERY_MS = 1000;
const FAR_DROP = ["hx", "hv", "gl", "mb", "ev", "sp", "em", "wb"];
const slimPresence = (p) => { const o = {}; for (const k in p) if (!FAR_DROP.includes(k)) o[k] = p[k]; return o; };
const chatMark = (p) => { const ch = Array.isArray(p.ch) ? p.ch : []; const m = ch[ch.length - 1]; return m && typeof m === "object" ? String(m.i) : ""; };
const farKey = (p) => [p.z, p.n, p.lv, p.c, p.d ? 1 : 0, p.lk, p.vd, chatMark(p)].join("|");

// #40 world bosses: each channel gets one boss at a time, in that boss's region.
// The times can be shortened with env vars (handy for tests); the defaults suit real play.
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const WB_FIRST = num(process.env.EMBER_WB_FIRST_MS, 5 * 60_000);  // after a channel opens
const WB_EVERY = num(process.env.EMBER_WB_EVERY_MS, 30 * 60_000); // after a boss falls or leaves
const WB_LIFE = num(process.env.EMBER_WB_LIFE_MS, 20 * 60_000);   // how long one stays before it leaves
const bosses = new Map(); // channel key -> { next, active: { b, z, until, key } | null, last }

function ensureSim(key, zone) {
  let s = sims.get(key);
  if (!s && hasSim(zone)) { s = { sim: new ZoneSim(zone), zone, idle: 0 }; s.sim.partyOf = getParty; sims.set(key, s); }
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

function playerName(ns, channel, id) {
  const ids = ns.adapter.rooms.get(channel);
  if (ids) for (const sid of ids) {
    const p = ns.sockets.get(sid)?.data.presence;
    if (p && String(p.id || sid).slice(0, 16) === id) return String(p.n || "Someone").slice(0, 16);
  }
  return "Someone";
}

function bossTick(ns, nowMs) {
  for (const ch of channels.keys()) if (!bosses.has(ch)) bosses.set(ch, { next: nowMs + WB_FIRST, active: null, last: null });
  for (const [ch, st] of bosses) {
    if (!channels.has(ch)) { // channel emptied: drop its boss
      if (st.active) sims.get(st.active.key)?.sim.removeBoss();
      bosses.delete(ch); continue;
    }
    const a = st.active;
    if (a) {
      const s = sims.get(a.key);
      if (!s || !s.sim.wb || s.sim.wb.dead) { st.active = null; st.next = nowMs + WB_EVERY; continue; }
      if (nowMs >= a.until) {
        s.sim.removeBoss(); st.active = null; st.next = nowMs + WB_EVERY;
        ns.to(ch).emit("wboss", { k: "gone", b: a.b, z: a.z });
      }
      continue;
    }
    if (nowMs < st.next || !WORLD_BOSSES.length) continue;
    // pick a boss, avoiding the last one when there is a choice
    const pool = WORLD_BOSSES.length > 1 ? WORLD_BOSSES.filter((b) => b !== st.last) : WORLD_BOSSES;
    const b = pool[Math.floor(Math.random() * pool.length)], z = MOBS[b].world, key = `${ch}|${z}`;
    const s = ensureSim(key, z);
    if (!s) { st.next = nowMs + WB_EVERY; continue; }
    s.sim.addBoss(b);
    st.active = { b, z, until: nowMs + WB_LIFE, key }; st.last = b;
    s.sim.onBossDown = (m, mvpId) => {
      const mvp = mvpId ? playerName(ns, ch, mvpId) : null;
      st.active = null; st.next = Date.now() + WB_EVERY;
      ns.to(ch).emit("wboss", { k: "down", b, z, mvp });
    };
    ns.to(ch).emit("wboss", { k: "up", b, z, left: Math.round(WB_LIFE / 1000) });
  }
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
        if (!players.length) {
          if (s.sim.wb && !s.sim.wb.dead) { s.idle = 0; continue; } // keep a region with a waiting world boss alive
          s.idle += TICK_MS; if (s.idle > 60_000) sims.delete(key); continue;
        }
        s.idle = 0;
        s.sim.tick(TICK_MS / 1000, players);
        const wb = s.sim.bossState();
        ns.to(key).emit("mobs", { z: s.zone, mb: s.sim.snapshot(), ev: s.sim.evs, ...(wb ? { wb } : {}) });
      } catch (err) {
        sims.delete(key); // a broken region restarts fresh next time someone is there
      }
    }
  }, TICK_MS).unref();
  setInterval(() => { try { bossTick(ns, Date.now()); } catch { /* never let the boss timer break the game */ } }, 1000).unref();
  startGuildWar(ns); // the evening guild war over Emberkeep

  // Logging in is optional: guests can play too (their progress stays on their device).
  // A banned account is turned away (the message starts with "banned:" so the game shows it and does not fall back).
  ns.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    socket.data.username = null;
    if (token) {
      try { socket.data.username = verifyEmbervaleToken(token).username; } catch { /* expired token: play as guest */ }
    }
    try {
      const banned = await loadModeration(socket);
      if (banned) return next(new Error(banned));
    } catch { /* database hiccup: let them in */ }
    next();
  });

  ns.on("connection", (socket) => {
    attachSocial(socket, ns); // whispers, parties, friends
    attachTrade(socket, ns);  // trading and player shops
    attachGuild(socket, ns);  // guilds (accounts only)
    attachMod(socket, ns);    // reports, and admin mute / kick / ban
    attachArena(socket, ns);  // ranked arena matches
    attachGuildWar(socket, ns); // Emberkeep guild war: owner, schedule
    attachGuildWarAdmin(socket, ns);
    attachErrors(socket);     // admin window: players' script errors
    const peerInfo = (pres) => ({ peer: socket.id, presence: pres === undefined ? socket.data.presence || null : pres, guest: !socket.data.username, guild: socket.data.guild ? { n: socket.data.guild.name, e: socket.data.guild.emblem } : null });
    // slim copies for the rest of the channel: at once when what they show changes, else at most once a second
    let farAt = 0, farTimer = null, farLast = "";
    const sendFar = () => {
      farTimer = null; farAt = Date.now();
      const p = socket.data.presence, key = socket.data.channel;
      if (!p || !key) return;
      farLast = farKey(p);
      const near = socket.data.presRoom;
      (near ? socket.to(key).except(near) : socket.to(key)).emit("peer", peerInfo(slimPresence(p)));
    };
    const relay = (zoneChanged) => {
      const p = socket.data.presence, near = socket.data.presRoom;
      if (near) socket.to(near).emit("peer", peerInfo());
      const urgent = zoneChanged || farKey(p) !== farLast;
      if (urgent || Date.now() - farAt >= FAR_EVERY_MS) { if (farTimer) { clearTimeout(farTimer); farTimer = null; } sendFar(); }
      else if (!farTimer) farTimer = setTimeout(() => { try { sendFar(); } catch { /* ignore */ } }, FAR_EVERY_MS - (Date.now() - farAt));
    };
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
      if (socket.data.presRoom) socket.leave(socket.data.presRoom);
      if (farTimer) { clearTimeout(farTimer); farTimer = null; }
      socket.data.zone = socket.data.zoneRoom = socket.data.presRoom = null;
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
          if (s && s.data.presence) peers.push({ peer: id, presence: s.data.presence, guest: !s.data.username, guild: s.data.guild ? { n: s.data.guild.name, e: s.data.guild.emblem } : null });
        }
        socket.emit("joined", { channel: n, peers, account: socket.data.username, sim: true });
        const wb = bosses.get(key)?.active; // tell a newcomer about a boss that is already out
        if (wb) socket.emit("wboss", { k: "up", b: wb.b, z: wb.z, left: Math.max(0, Math.round((wb.until - Date.now()) / 1000)), late: 1 });
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
        filterPresenceChat(socket, presence); // a muted player's chat is dropped; the rest is kept as report evidence
        socket.data.presence = presence;

        // keep the socket in a per-region room so it gets that region's monster updates
        const zone = typeof presence.z === "string" ? presence.z.slice(0, 16) : null;
        const moved = zone !== socket.data.zone;
        if (moved) {
          // the region's presence room: full updates flow between everyone in it
          if (socket.data.presRoom) socket.leave(socket.data.presRoom);
          socket.data.presRoom = zone ? `${socket.data.channel}@${zone}` : null;
          if (socket.data.presRoom) {
            socket.join(socket.data.presRoom);
            // catch up on everyone already here (they may be standing still and sending nothing)
            for (const id of ns.adapter.rooms.get(socket.data.presRoom) || []) {
              if (id === socket.id) continue;
              const s = ns.sockets.get(id);
              if (s && s.data.presence) socket.emit("peer", { peer: id, presence: s.data.presence, guest: !s.data.username, guild: s.data.guild ? { n: s.data.guild.name, e: s.data.guild.emblem } : null });
            }
          }
        }
        relay(moved);
        if (moved) {
          if (socket.data.zoneRoom) socket.leave(socket.data.zoneRoom);
          socket.data.zone = zone;
          socket.data.zoneRoom = zone && hasSim(zone) ? `${socket.data.channel}|${zone}` : null;
          socket.data.hxSeen = 0;
          if (socket.data.zoneRoom) { socket.join(socket.data.zoneRoom); ensureSim(socket.data.zoneRoom, zone); }
        }
        // hits this player reports on the server's monsters
        const s = socket.data.zoneRoom && sims.get(socket.data.zoneRoom);
        if (s && Array.isArray(presence.hx)) {
          const who = { id: String(presence.id || socket.id).slice(0, 16), x: Number(presence.x) || 0, y: Number(presence.y) || 0, lv: presence.lv, party: socket.data.partyId || null };
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

module.exports = { attachEmbervale, onlineCount, _bosses: bosses, _sims: sims };
