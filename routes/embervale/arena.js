// Embervale arena: ranked 1v1 and 2v2 matches with an Elo-style rating.
// The server pairs players who queue in the same channel, runs the match clock and keeps score.
// Hits travel between the players' games (like duels); each player reports only their own defeat
// ("arenaOut"), so nobody can claim a win they didn't earn. Leaving or disconnecting counts as out.
// Ranked play needs an account. Every handler is wrapped so a bad message only fails that socket.
const EmberAccount = require("../../models/embervale/EmberAccount");
const { getParty } = require("./social");

const MODES = { "1v1": 1, "2v2": 2 };
const SLOTS = 4;                 // pits in the arena region: matches at once per channel
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const FIGHT_IN_MS = num(process.env.EMBER_ARENA_START_MS, 6000); // countdown before the fight
const MATCH_MS = num(process.env.EMBER_ARENA_MATCH_MS, 180_000);
const START_RATING = 1000, K = 32;

const clean = (t, n) => String(t ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, n);
const nameOf = (s) => clean(s?.data?.presence?.n, 16) || "Traveller";

const queues = new Map();  // "channel|mode" -> [{ sids: [...], at }]
const matches = new Map(); // match id -> match
let matchSeq = 0;

const ratingOf = (doc) => ({ r: START_RATING, w: 0, l: 0, d: 0, ...(doc && doc.arena) });

function inQueue(sid) {
  for (const q of queues.values()) if (q.some((e) => e.sids.includes(sid))) return true;
  return false;
}
function dropFromQueues(sid, ns, why) {
  for (const [key, q] of queues) {
    const i = q.findIndex((e) => e.sids.includes(sid));
    if (i < 0) continue;
    const [e] = q.splice(i, 1);
    for (const id of e.sids) ns.sockets.get(id)?.emit("arenaQueue", { mode: null, why: id === sid ? undefined : why });
    if (!q.length) queues.delete(key);
  }
}
const matchOf = (sid) => { for (const m of matches.values()) if (m.teams.some((t) => t.includes(sid))) return m; return null; };

function freeSlot(channel) {
  const used = new Set([...matches.values()].filter((m) => m.channel === channel).map((m) => m.slot));
  for (let s = 0; s < SLOTS; s++) if (!used.has(s)) return s;
  return -1;
}

function tryMatch(key, ns) {
  const q = queues.get(key);
  if (!q || q.length < 2) return;
  const [channel, mode] = key.split("|");
  const slot = freeSlot(channel);
  if (slot < 0) return; // every pit is busy: wait for one to finish
  const [a, b] = q.splice(0, 2);
  if (!q.length) queues.delete(key);
  const m = { id: "m" + ++matchSeq, mode, channel, slot, teams: [a.sids, b.sids], out: new Set(), names: {}, accounts: {}, start: Date.now() + FIGHT_IN_MS, done: false };
  const roster = m.teams.map((t) => t.map((sid) => {
    const s = ns.sockets.get(sid);
    m.names[sid] = nameOf(s); m.accounts[sid] = s?.data.username || null;
    return { peer: sid, id: clean(s?.data.presence?.id, 16), name: nameOf(s) };
  }));
  matches.set(m.id, m);
  m.timer = setTimeout(() => { try { finish(m, -1, ns); } catch { /* ignore */ } }, FIGHT_IN_MS + MATCH_MS);
  m.teams.forEach((t, ti) => t.forEach((sid) => ns.sockets.get(sid)?.emit("arenaMatch", {
    id: m.id, mode, slot, you: ti, teams: roster, fightIn: Math.round(FIGHT_IN_MS / 1000), time: Math.round(MATCH_MS / 1000),
  })));
}

// a team is beaten when every member is out
function checkEnd(m, ns) {
  const beaten = m.teams.map((t) => t.every((sid) => m.out.has(sid)));
  if (beaten[0] && beaten[1]) return finish(m, -1, ns);
  if (beaten[0]) return finish(m, 1, ns);
  if (beaten[1]) return finish(m, 0, ns);
}

async function finish(m, winner, ns) {
  if (m.done) return;
  m.done = true; clearTimeout(m.timer); matches.delete(m.id);
  // team ratings: the average of the members' ratings
  const docs = {};
  for (const sid of m.teams.flat()) {
    const u = m.accounts[sid];
    if (u && !docs[u]) docs[u] = ratingOf(await EmberAccount.findOne({ username: u }, { arena: 1 }).lean());
  }
  const teamR = m.teams.map((t) => t.reduce((a, sid) => a + (docs[m.accounts[sid]]?.r ?? START_RATING), 0) / t.length);
  for (let ti = 0; ti < 2; ti++) {
    const expect = 1 / (1 + Math.pow(10, (teamR[1 - ti] - teamR[ti]) / 400));
    const score = winner < 0 ? 0.5 : winner === ti ? 1 : 0;
    const delta = winner < 0 ? 0 : Math.round(K * (score - expect)) || (score ? 1 : -1);
    for (const sid of m.teams[ti]) {
      const u = m.accounts[sid];
      let rec = null;
      if (u) {
        rec = docs[u];
        rec.r = Math.max(0, rec.r + delta);
        if (winner < 0) rec.d++; else if (winner === ti) rec.w++; else rec.l++;
        rec.name = m.names[sid];
        await EmberAccount.updateOne({ username: u }, { arena: rec });
      }
      ns.sockets.get(sid)?.emit("arenaResult", { id: m.id, result: winner < 0 ? "draw" : winner === ti ? "win" : "loss", delta, rating: rec ? rec.r : null, w: rec?.w, l: rec?.l, d: rec?.d });
    }
  }
  // a pit is free again: start anyone waiting in this channel
  for (const key of [...queues.keys()]) if (key.startsWith(m.channel + "|")) tryMatch(key, ns);
}

function markOut(sid, ns) {
  const m = matchOf(sid);
  if (!m || m.done || m.out.has(sid)) return;
  m.out.add(sid);
  for (const id of m.teams.flat()) ns.sockets.get(id)?.emit("arenaState", { id: m.id, out: [...m.out] });
  checkEnd(m, ns);
}

function attachArena(socket, ns) {
  const on = (ev, fn) => socket.on(ev, async (msg) => { try { await fn(msg && typeof msg === "object" ? msg : {}); } catch { /* ignore bad message */ } });
  const error = (text) => socket.emit("socialError", { error: text });

  on("arenaJoin", (msg) => {
    const mode = MODES[msg.mode] ? msg.mode : null;
    if (!mode) return;
    if (!socket.data.username) return error("Ranked arena matches need an account. Log in or sign up first.");
    if (!socket.data.channel || !socket.data.presence) return;
    if (matchOf(socket.id)) return error("You are already in a match.");
    if (inQueue(socket.id)) return error("You are already waiting for a match.");
    let sids = [socket.id];
    if (MODES[mode] === 2) {
      const p = getParty(socket.data.partyId);
      if (!p || p.members.size !== 2) return error("2v2 needs a party of exactly two. Invite a partner first.");
      if (p.leader !== socket.id) return error("Only the party leader can join the 2v2 queue.");
      sids = [...p.members];
      for (const sid of sids) {
        const s = ns.sockets.get(sid);
        if (!s || !s.data.username) return error(`${nameOf(s)} needs an account to play ranked matches.`);
        if (s.data.channel !== socket.data.channel) return error(`${nameOf(s)} is in another channel.`);
        if (matchOf(sid) || inQueue(sid)) return error(`${nameOf(s)} is busy with another match.`);
      }
    }
    const key = `${socket.data.channel}|${mode}`;
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push({ sids, at: Date.now() });
    for (const sid of sids) ns.sockets.get(sid)?.emit("arenaQueue", { mode, waiting: queues.get(key).length });
    tryMatch(key, ns);
  });

  on("arenaCancel", () => dropFromQueues(socket.id, ns, `${nameOf(socket)} left the queue.`));
  on("arenaOut", () => markOut(socket.id, ns));

  on("arenaInfo", async () => {
    const me = socket.data.username ? ratingOf(await EmberAccount.findOne({ username: socket.data.username }, { arena: 1 }).lean()) : null;
    const top = await EmberAccount.find({ "arena.r": { $exists: true } }, { arena: 1, username: 1 }).sort({ "arena.r": -1 }).limit(20).lean();
    let queued = null;
    for (const [key, q] of queues) if (q.some((e) => e.sids.includes(socket.id))) queued = key.split("|")[1];
    socket.emit("arenaInfo", {
      me, queued, inMatch: !!matchOf(socket.id),
      top: top.map((a) => ({ name: clean(a.arena.name, 16) || a.username, r: a.arena.r, w: a.arena.w || 0, l: a.arena.l || 0 })),
    });
  });

  socket.on("disconnect", () => {
    try { dropFromQueues(socket.id, ns, `${nameOf(socket)} left the game.`); markOut(socket.id, ns); } catch { /* ignore */ }
  });
}

module.exports = { attachArena, _arena: { queues, matches } };
