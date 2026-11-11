// Embervale social: whispers, parties (with shared EXP) and friends' online status.
// Parties live only in memory: they last while their members are connected.
// Every handler is wrapped so a bad message only fails that socket.
const MAX_PARTY = 12;
const MSGS_PER_SEC = 5;
const parties = new Map(); // id -> { id, leader: socketId, mode: "share" | "each", loot: "each" | "turns", turn, members: Set<socketId> }
let partySeq = 0;

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
    if (!to || !text) return;
    const targets = [...ns.sockets.values()].filter((s) => s !== socket && s.data.presence && nameOf(s).toLowerCase() === to.toLowerCase());
    for (const s of targets) s.emit("whisper", { from: nameOf(socket), text });
    socket.emit("whisperSent", { to, text, ok: targets.length > 0 });
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
    if (!p || !text) return;
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

  socket.on("disconnect", () => { try { leaveParty(socket, ns); } catch { /* ignore */ } });
}

const getParty = (id) => (id && parties.get(id)) || null;
module.exports = { attachSocial, leaveParty, getParty };
