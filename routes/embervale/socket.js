// Embervale live play: a presence relay on its own socket.io namespace.
// Each player sends one small "presence" object (position, chat, emotes, monster
// state from that region's host player...). The server keeps the latest one per
// player and forwards changes to everyone in the same room + channel.
// Busy rooms split into channels of CHANNEL_CAP players.
//
// Like routes/market/chatSocket.js, every handler is wrapped so a bad message can
// only fail that socket, never crash this shared backend.
const { verifyEmbervaleToken } = require("../../utils/embervaleAuth");

const CHANNEL_CAP = 40;
const MAX_PRESENCE_BYTES = 12_000;
const MAX_MSGS_PER_SEC = 20;

// "room:channel" -> Set of socket ids
const channels = new Map();
let nsRef = null;

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
        socket.emit("joined", { channel: n, peers, account: socket.data.username });
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
