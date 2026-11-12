// Embervale social: whispers, parties (with shared EXP) and friends' online status.
// Parties live only in memory: they last while their members are connected.
// Every handler is wrapped so a bad message only fails that socket.
const { chatAllowed } = require("./mod");
const MAX_PARTY = 12;
const MSGS_PER_SEC = 5;
const parties = new Map(); // id -> { id, leader: socketId, mode: "share" | "each", loot: "each" | "turns", turn, members: Set<socketId> }
let partySeq = 0;
// #48 chat rooms: named rooms anyone can join from any region or channel (one room per player at a time)
const MAX_ROOM = 50, MAX_ROOMS = 200;
const chatRooms = new Map(); // key (lower case) -> { name, members: Set<socketId> }
const roomKey = (n) => n.toLowerCase();
const cleanRoom = (t) => clean(t, 20).replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, " ").trim();
function roomState(r, ns) { return { name: r.name, members: [...r.members].map((id) => nameOf(ns.sockets.get(id))).slice(0, MAX_ROOM) }; }
function sendRoom(r, ns, note) { const st = roomState(r, ns); if (note) st.note = note; for (const id of r.members) ns.sockets.get(id)?.emit("room", st); }
function leaveRoom(socket, ns) {
  const r = chatRooms.get(socket.data.chatRoom);
  socket.data.chatRoom = null;
  if (!r) return;
  r.members.delete(socket.id);
  socket.emit("room", null);
  if (!r.members.size) chatRooms.delete(roomKey(r.name));
  else sendRoom(r, ns, `${nameOf(socket)} left`);
}

const clean = (t, n) => String(t ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, n);
const nameOf = (s) => clean(s?.data?.presence?.n, 16) || "Traveller";
const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

function partyState(p, ns) {
  return { id: p.id, leader: p.leader, mode: p.mode, loot: p.loot || "each", members: [...p.members].map((id) => ({ peer: id, name: nameOf(ns.sockets.get(id)) })) };
}
function sendParty(p, ns) {
  const st = partyState(p, ns);
  for (const id of p.members) ns.sockets.get(id)?.emit("party", st);
}
function leaveParty(socket, ns) {
  const p = parties.get(socket.data.partyId);
  socket.data.partyId = null;
  if (!p) return;
  p.members.delete(socket.id);
  socket.emit("party", null);
  if (!p.members.size) { parties.delete(p.id); return; }
  if (p.leader === socket.id) p.leader = [...p.members][0];
  if (p.members.size === 1) { // a party of one is no party
    const last = ns.sockets.get([...p.members][0]);
    parties.delete(p.id);
    if (last) { last.data.partyId = null; last.emit("party", null); }
    return;
  }
  sendParty(p, ns);
}

function attachSocial(socket, ns) {
  let tokens = MSGS_PER_SEC, last = Date.now();
  const allow = () => {
    const now = Date.now();
    tokens = Math.min(MSGS_PER_SEC, tokens + ((now - last) / 1000) * MSGS_PER_SEC);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
  const on = (ev, fn) => socket.on(ev, (msg) => { try { if (allow()) fn(msg || {}); } catch { /* ignore bad message */ } });
  const error = (text) => socket.emit("socialError", { error: text });
  const myParty = () => parties.get(socket.data.partyId);

  // ---- whispers: by character name, to anyone online in any room or channel
  on("whisper", (msg) => {
    const to = clean(msg.to, 16), text = clean(msg.text, 120);
    if (!to || !text || !chatAllowed(socket, "whisper", text, to)) return;
    const targets = [...ns.sockets.values()].filter((s) => s !== socket && s.data.presence && nameOf(s).toLowerCase() === to.toLowerCase());
    for (const s of targets) s.emit("whisper", { from: nameOf(socket), text });
    socket.emit("whisperSent", { to, text, ok: targets.length > 0 });
  });

  // ---- chat rooms
  on("roomJoin", (msg) => {
    const name = cleanRoom(msg.name);
    if (name.length < 2) { error("Room names need 2-20 letters or numbers."); return; }
    const key = roomKey(name);
    if (socket.data.chatRoom === key) return;
    let r = chatRooms.get(key);
    if (!r) { if (chatRooms.size >= MAX_ROOMS) { error("Too many rooms are open right now. Try an existing one (/rooms)."); return; } r = { name, members: new Set() }; chatRooms.set(key, r); }
    if (r.members.size >= MAX_ROOM) { error(`${r.name} is full.`); if (!r.members.size) chatRooms.delete(key); return; }
    leaveRoom(socket, ns);
    r.members.add(socket.id); socket.data.chatRoom = key;
    sendRoom(r, ns, `${nameOf(socket)} joined`);
  });
  on("roomLeave", () => leaveRoom(socket, ns));
  on("roomChat", (msg) => {
    const r = chatRooms.get(socket.data.chatRoom), text = clean(msg.text, 120);
    if (!r || !text || !chatAllowed(socket, "room", text, r.name)) return;
    for (const id of r.members) ns.sockets.get(id)?.emit("roomChat", { room: r.name, from: nameOf(socket), text });
  });
  on("roomList", () => {
    const list = [...chatRooms.values()].sort((a, b) => b.members.size - a.members.size).slice(0, 20).map((r) => ({ name: r.name, n: r.members.size }));
    socket.emit("roomList", list);
  });

  // ---- parties: invite someone in your channel, they accept or decline
  on("partyInvite", (msg) => {
    const target = ns.sockets.get(String(msg.peer));
    if (!target || target === socket || !target.data.presence) return error("That player is not here.");
    if (target.data.channel !== socket.data.channel) return error(`${nameOf(target)} is in another channel.`);
    if (target.data.partyId) return error(`${nameOf(target)} is already in a party.`);
    const p = myParty();
    if (p && p.members.size >= MAX_PARTY) return error(`A party can have at most ${MAX_PARTY} members.`);
    (target.data.invites ||= new Map()).set(socket.id, Date.now());
    target.emit("partyInvite", { fromPeer: socket.id, from: nameOf(socket) });
    socket.emit("socialInfo", { info: `Invited ${nameOf(target)} to your party.` });
  });
  on("partyAccept", (msg) => {
    const from = ns.sockets.get(String(msg.peer));
    const at = socket.data.invites?.get(String(msg.peer));
    socket.data.invites?.delete(String(msg.peer));
    if (!from || !at || Date.now() - at > 120_000) return error("That invitation has expired.");
    if (socket.data.partyId) leaveParty(socket, ns);
    let p = parties.get(from.data.partyId);
    if (!p) {
      p = { id: "p" + ++partySeq, leader: from.id, mode: "share", loot: "each", turn: 0, members: new Set([from.id]) };
      parties.set(p.id, p);
      from.data.partyId = p.id;
    }
    if (p.members.size >= MAX_PARTY) return error("That party is full.");
    p.members.add(socket.id);
    socket.data.partyId = p.id;
    sendParty(p, ns);
  });
  on("partyDecline", (msg) => {
    socket.data.invites?.delete(String(msg.peer));
    ns.sockets.get(String(msg.peer))?.emit("socialInfo", { info: `${nameOf(socket)} declined your party invitation.` });
  });
  on("partyLeave", () => leaveParty(socket, ns));
  on("partyKick", (msg) => {
    const p = myParty();
    if (!p || p.leader !== socket.id) return;
    const t = ns.sockets.get(String(msg.peer));
    if (!t || t === socket || !p.members.has(t.id)) return;
    leaveParty(t, ns);
    t.emit("socialError", { error: "You were removed from the party." });
  });
  on("partyMode", (msg) => {
    const p = myParty();
    if (!p || p.leader !== socket.id) return;
    p.mode = msg.mode === "each" ? "each" : "share";
    sendParty(p, ns);
  });
  // loot rule: everyone rolls their own drops, or the party takes turns (one roll per kill, rotating)
  on("partyLoot", (msg) => {
    const p = myParty();
    if (!p || p.leader !== socket.id) return;
    p.loot = msg.loot === "turns" ? "turns" : "each";
    sendParty(p, ns);
  });
  on("partyChat", (msg) => {
    const p = myParty(), text = clean(msg.text, 120);
    if (!p || !text || !chatAllowed(socket, "party", text)) return;
    for (const id of p.members) ns.sockets.get(id)?.emit("partyChat", { from: nameOf(socket), text });
  });
  // shared EXP: the player who made the kill passes each member in the same region their share
  on("partyExp", (msg) => {
    const p = myParty();
    if (!p || p.mode !== "share") return;
    const exp = int(msg.exp, 5_000_000), jexp = int(msg.jexp, 5_000_000), zone = socket.data.presence?.z;
    for (const id of p.members) {
      if (id === socket.id) continue;
      const s = ns.sockets.get(id);
      if (s && s.data.presence?.z === zone && !s.data.presence?.d) s.emit("partyExp", { exp, jexp, from: nameOf(socket) });
    }
  });

  // ---- friends: which of these names are online right now
  on("friends", (msg) => {
    const want = new Set((Array.isArray(msg.names) ? msg.names : []).slice(0, 50).map((n) => clean(n, 16).toLowerCase()));
    const online = new Set();
    for (const s of ns.sockets.values()) if (s.data.presence && want.has(nameOf(s).toLowerCase())) online.add(nameOf(s));
    socket.emit("friends", { online: [...online] });
  });

  socket.on("disconnect", () => { try { leaveParty(socket, ns); } catch { /* ignore */ } try { leaveRoom(socket, ns); } catch { /* ignore */ } });
}

const getParty = (id) => (id && parties.get(id)) || null;
module.exports = { attachSocial, leaveParty, getParty };
