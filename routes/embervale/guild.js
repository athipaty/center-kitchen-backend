// Embervale guilds: create one with a name and emblem, invite players, ranks (leader, officer,
// member), a notice, and guild chat across every room and channel. Guilds are saved in MongoDB
// and belong to accounts, so guests cannot join. Every handler is wrapped so a bad message
// only fails that socket.
const EmberGuild = require("../../models/embervale/EmberGuild");
const { chatAllowed } = require("./mod");

const MAX_MEMBERS = 30;
const MSGS_PER_SEC = 4;
const EMBLEM_MAX = [6, 8, 8]; // shapes, colours, backgrounds
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '-]{1,18}[A-Za-z0-9]$/;
const RANK = { leader: 3, officer: 2, member: 1 };

const clean = (t, n) => String(t ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, n);
const nameOf = (s) => clean(s?.data?.presence?.n, 16) || "Traveller";
const emblemOf = (e) => (Array.isArray(e) ? EMBLEM_MAX.map((m, i) => Math.max(0, Math.min(m - 1, Math.floor(Number(e[i]) || 0)))) : [0, 0, 0]);

// tell the channel about a player's new guild tag (shown over their head)
function retag(s) {
  if (!s.data.channel || !s.data.presence) return;
  s.to(s.data.channel).emit("peer", { peer: s.id, presence: s.data.presence, guest: !s.data.username, guild: s.data.guild ? { n: s.data.guild.name, e: s.data.guild.emblem } : null });
}

// sockets of online members, by guild id
function onlineOf(ns, gid) {
  const out = [];
  for (const s of ns.sockets.values()) if (s.data.guild && s.data.guild.id === gid) out.push(s);
  return out;
}

function stateFor(g, online) {
  const on = new Map(online.map((s) => [s.data.username, s]));
  return {
    id: String(g._id), name: g.name, emblem: emblemOf(g.emblem), notice: g.notice || "",
    members: g.members.map((m) => {
      const s = on.get(m.u);
      return { u: m.u, c: s ? nameOf(s) : m.c || m.u, rank: m.rank, on: !!s, z: s ? clean(s.data.presence?.z, 16) : null };
    }),
  };
}

// send the guild to every online member (which also refreshes their name tags)
async function broadcast(ns, gid, g) {
  g = g || (await EmberGuild.findById(gid).lean());
  const online = onlineOf(ns, gid);
  if (!g) { for (const s of online) { s.data.guild = null; s.emit("guild", null); retag(s); } return; }
  const st = stateFor(g, online);
  for (const s of online) {
    s.data.guild = { id: st.id, name: g.name, emblem: st.emblem };
    s.emit("guild", { ...st, me: s.data.username });
    retag(s); // guild changes are rare, so always refresh the name tag
  }
}

function attachGuild(socket, ns) {
  let tokens = MSGS_PER_SEC, last = Date.now();
  const allow = () => {
    const now = Date.now();
    tokens = Math.min(MSGS_PER_SEC, tokens + ((now - last) / 1000) * MSGS_PER_SEC);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
  const error = (text) => socket.emit("socialError", { error: text });
  const info = (text) => socket.emit("socialInfo", { info: text });
  const user = () => socket.data.username;
  const on = (ev, fn) => socket.on(ev, async (msg) => {
    try {
      if (!allow()) return;
      if (!user()) return error("Guilds need an account. Log in from the title screen to create or join one.");
      await fn(msg || {});
    } catch { error("Something went wrong with the guild. Try again."); }
  });
  const mine = async () => (socket.data.guild ? EmberGuild.findById(socket.data.guild.id) : null);
  const myRank = (g) => g?.members.find((m) => m.u === user())?.rank;

  // load my guild when I connect with an account (broadcast() then shows my tag to the channel)
  socket.data.guild = null;
  if (user()) {
    EmberGuild.findOne({ "members.u": user() }).lean().then((g) => {
      if (!g || !socket.connected) return;
      socket.data.guild = { id: String(g._id), name: g.name, emblem: emblemOf(g.emblem) };
      return broadcast(ns, String(g._id), g); // everyone sees me come online
    }).catch(() => {});
  }

  on("guildCreate", async (msg) => {
    const name = clean(msg.name, 20).replace(/\s+/g, " ");
    if (!NAME_RE.test(name)) return error("Guild names are 3-20 letters, numbers, spaces, ' or -.");
    if (socket.data.guild || (await EmberGuild.exists({ "members.u": user() }))) return error("Leave your guild first.");
    if (await EmberGuild.exists({ key: name.toLowerCase() })) return error("That guild name is taken.");
    let g;
    try {
      g = await EmberGuild.create({ name, key: name.toLowerCase(), emblem: emblemOf(msg.emblem), members: [{ u: user(), c: nameOf(socket), rank: "leader" }] });
    } catch (err) { return error(err?.code === 11000 ? "That guild name is taken." : "Could not create the guild."); }
    socket.data.guild = { id: String(g._id), name: g.name, emblem: emblemOf(g.emblem) };
    socket.emit("guildCreated", { name: g.name });
    await broadcast(ns, String(g._id), g.toObject());
  });

  on("guildInvite", async (msg) => {
    const g = await mine();
    if (!g) return error("You are not in a guild.");
    if (RANK[myRank(g)] < RANK.officer) return error("Only the leader and officers can invite.");
    const target = ns.sockets.get(String(msg.peer));
    if (!target || target === socket || !target.data.presence) return error("That player is not here.");
    if (!target.data.username) return error(`${nameOf(target)} is playing as a guest and needs an account to join a guild.`);
    if (target.data.guild) return error(`${nameOf(target)} is already in a guild.`);
    if (g.members.length >= MAX_MEMBERS) return error(`A guild can have at most ${MAX_MEMBERS} members.`);
    (target.data.guildInvites ||= new Map()).set(String(g._id), Date.now());
    target.emit("guildInvite", { gid: String(g._id), guild: g.name, emblem: emblemOf(g.emblem), from: nameOf(socket) });
    info(`Invited ${nameOf(target)} to ${g.name}.`);
  });

  on("guildAccept", async (msg) => {
    const gid = String(msg.gid || "");
    const at = socket.data.guildInvites?.get(gid);
    socket.data.guildInvites?.delete(gid);
    if (!at || Date.now() - at > 120_000) return error("That invitation has expired.");
    if (socket.data.guild || (await EmberGuild.exists({ "members.u": user() }))) return error("Leave your guild first.");
    const g = await EmberGuild.findOneAndUpdate(
      { _id: gid, "members.u": { $ne: user() }, [`members.${MAX_MEMBERS - 1}`]: { $exists: false } },
      { $push: { members: { u: user(), c: nameOf(socket), rank: "member" } } },
      { returnDocument: "after" }
    ).lean();
    if (!g) return error("That guild is full or no longer exists.");
    socket.data.guild = { id: gid, name: g.name, emblem: emblemOf(g.emblem) };
    for (const s of onlineOf(ns, gid)) if (s !== socket) s.emit("guildChat", { from: "", text: `${nameOf(socket)} joined the guild.` });
    await broadcast(ns, gid, g);
  });

  on("guildDecline", (msg) => { socket.data.guildInvites?.delete(String(msg.gid || "")); });

  async function removeMember(g, u, why) {
    g.members = g.members.filter((m) => m.u !== u);
    const gid = String(g._id);
    for (const s of ns.sockets.values()) {
      if (s.data.username !== u) continue;
      s.data.guild = null; s.emit("guild", null); retag(s);
      if (why) s.emit("socialError", { error: why });
    }
    if (!g.members.length) { await EmberGuild.deleteOne({ _id: g._id }); return; }
    if (!g.members.some((m) => m.rank === "leader")) { // hand the guild on: an officer, else the longest member
      (g.members.find((m) => m.rank === "officer") || g.members[0]).rank = "leader";
    }
    await g.save();
    await broadcast(ns, gid, g.toObject());
  }

  on("guildLeave", async () => {
    const g = await mine();
    if (!g) return;
    await removeMember(g, user());
    info(`You left ${g.name}.`);
  });

  on("guildKick", async (msg) => {
    const g = await mine();
    if (!g) return;
    const t = g.members.find((m) => m.u === clean(msg.u, 16));
    if (!t || t.u === user()) return;
    if (RANK[myRank(g)] < RANK.officer || RANK[t.rank] >= RANK[myRank(g)]) return error("You can only remove members of a lower rank.");
    await removeMember(g, t.u, `You were removed from ${g.name}.`);
  });

  on("guildRank", async (msg) => {
    const g = await mine();
    if (!g || myRank(g) !== "leader") return error("Only the guild leader can change ranks.");
    const t = g.members.find((m) => m.u === clean(msg.u, 16));
    const rank = String(msg.rank);
    if (!t || t.u === user() || !RANK[rank]) return;
    if (rank === "leader") { g.members.find((m) => m.u === user()).rank = "officer"; t.rank = "leader"; }
    else t.rank = rank;
    await g.save();
    await broadcast(ns, String(g._id), g.toObject());
  });

  on("guildEdit", async (msg) => {
    const g = await mine();
    if (!g || RANK[myRank(g)] < RANK.officer) return error("Only the leader and officers can change the guild.");
    if (msg.emblem !== undefined) g.emblem = emblemOf(msg.emblem);
    if (msg.notice !== undefined) g.notice = clean(msg.notice, 120);
    await g.save();
    await broadcast(ns, String(g._id), g.toObject());
  });

  on("guildDisband", async () => {
    const g = await mine();
    if (!g || myRank(g) !== "leader") return error("Only the guild leader can disband the guild.");
    const online = onlineOf(ns, String(g._id));
    await EmberGuild.deleteOne({ _id: g._id });
    for (const s of online) { s.data.guild = null; s.emit("guild", null); retag(s); if (s !== socket) s.emit("socialError", { error: `${g.name} was disbanded.` }); }
  });

  on("guildChat", (msg) => {
    const text = clean(msg.text, 120);
    if (!socket.data.guild || !text || !chatAllowed(socket, "guild", text)) return;
    for (const s of onlineOf(ns, socket.data.guild.id)) s.emit("guildChat", { from: nameOf(socket), text });
  });

  // a fresh member list (who is online, where)
  on("guildGet", async () => { if (socket.data.guild) await broadcast(ns, socket.data.guild.id); else socket.emit("guild", null); });

  socket.on("disconnect", () => {
    const gid = socket.data.guild?.id;
    socket.data.guild = null;
    if (gid) broadcast(ns, gid).catch(() => {}); // members see me go offline
  });
}

module.exports = { attachGuild };
