// Embervale moderation: players report each other; admins review reports and mute, kick or ban.
// Admins are the account usernames listed in EMBERVALE_ADMINS (comma separated).
// Account mutes and bans are stored on the account; a guest can only be muted (until they reconnect) or kicked.
// Every handler is wrapped so a bad message only fails that socket.
const EmberAccount = require("../../models/embervale/EmberAccount");
const EmberReport = require("../../models/embervale/EmberReport");

const REASONS = ["spam", "abuse", "cheating", "name", "other"];
const REPORTS_PER_10MIN = 5;
const SAID_KEEP = 12;
const clean = (t, n) => String(t ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, n);
const nameOf = (s) => clean(s?.data?.presence?.n, 16) || "Traveller";
const admins = () => new Set(String(process.env.EMBERVALE_ADMINS || "").split(",").map((u) => u.trim().toLowerCase()).filter(Boolean));
const isAdminName = (u) => !!u && admins().has(String(u).toLowerCase());
const isAdmin = (socket) => isAdminName(socket.data.username);
const mutedFor = (socket) => Math.max(0, (socket.data.mutedUntil || 0) - Date.now());
const minutes = (ms) => Math.max(1, Math.ceil(ms / 60000));
const mutedText = (socket) => { const m = minutes(mutedFor(socket)); return `You are muted for ${m} more minute${m === 1 ? "" : "s"}.`; };

// Called from the socket middleware: load this account's mute and ban. Returns an error text when banned.
async function loadModeration(socket) {
  if (!socket.data.username) return null;
  const a = await EmberAccount.findOne({ username: socket.data.username }, { mutedUntil: 1, bannedUntil: 1, banReason: 1 }).lean();
  if (!a) return null;
  socket.data.mutedUntil = a.mutedUntil ? +a.mutedUntil : 0;
  if (a.bannedUntil && +a.bannedUntil > Date.now()) {
    const days = Math.ceil((+a.bannedUntil - Date.now()) / 86400000);
    return `banned: This account is banned for ${days} more day${days === 1 ? "" : "s"}${a.banReason ? ` (${a.banReason})` : ""}.`;
  }
  return null;
}

// Remember what a player said (report evidence). kind: say | party | guild | whisper (with to)
function remember(socket, kind, text, to) {
  const said = (socket.data.said ||= []);
  said.push({ t: new Date(), kind, text: clean(text, 120), to: to ? String(to).toLowerCase() : undefined });
  if (said.length > SAID_KEEP) said.splice(0, said.length - SAID_KEEP);
}

// Presence filter: a muted player's chat lines are dropped (announcements like level-ups stay); new lines are remembered.
function filterPresenceChat(socket, presence) {
  if (!Array.isArray(presence.ch)) return;
  const muted = mutedFor(socket) > 0;
  const out = [];
  for (const m of presence.ch.slice(-4)) {
    if (!m || typeof m !== "object") continue;
    if (m.k) { out.push(m); continue; }
    const i = Number(m.i) || 0, fresh = i > (socket.data.chSeen || 0);
    if (fresh) socket.data.chSeen = i;
    if (muted) { if (fresh) socket.emit("socialError", { error: mutedText(socket) }); continue; }
    if (fresh) remember(socket, "say", m.s);
    out.push(m);
  }
  presence.ch = out;
}

// For whisper / party / guild chat handlers: false (and a notice) when muted
function chatAllowed(socket, kind, text, to) {
  if (mutedFor(socket) > 0) { socket.emit("socialError", { error: mutedText(socket) }); return false; }
  remember(socket, kind, text, to);
  return true;
}

function playerRow(s) {
  const p = s.data.presence || {}, m = mutedFor(s);
  return { peer: s.id, name: nameOf(s), account: s.data.username || null, lv: Number(p.lv) || 1, zone: clean(p.z, 16), channel: s.data.channel || "", muted: m > 0 ? minutes(m) : 0, admin: isAdmin(s) };
}
const reportRow = (r) => ({ id: String(r._id), at: r.createdAt, reporter: r.reporterName, reporterAccount: r.reporter, target: r.target, targetAccount: r.targetAccount, reason: r.reason, note: r.note, chat: r.chat, zone: r.zone, status: r.status, handledBy: r.handledBy, action: r.action });

function attachMod(socket, ns) {
  const on = (ev, fn, adminOnly) => socket.on(ev, async (msg) => {
    try { if (adminOnly && !isAdmin(socket)) return; await fn(msg && typeof msg === "object" ? msg : {}); } catch { /* ignore bad message */ }
  });
  const info = (text) => socket.emit("socialInfo", { info: text });
  const error = (text) => socket.emit("socialError", { error: text });
  if (isAdmin(socket)) socket.emit("modHello", { admin: true });
  if (mutedFor(socket) > 0) socket.emit("modMuted", { minutes: minutes(mutedFor(socket)) });

  // ---- reports: anyone can report a player who is online
  const sent = []; // { t, peer } of this socket's recent reports
  on("report", async (msg) => {
    const target = ns.sockets.get(String(msg.peer));
    if (!target || target === socket || !target.data.presence) return error("That player is not here any more.");
    const nowMs = Date.now();
    while (sent.length && nowMs - sent[0].t > 600_000) sent.shift();
    if (sent.some((x) => x.peer === target.id)) return error(`You already reported ${nameOf(target)}. The admins will look at it.`);
    if (sent.length >= REPORTS_PER_10MIN) return error("You have sent a lot of reports. Please wait a few minutes.");
    sent.push({ t: nowMs, peer: target.id });
    const me = nameOf(socket).toLowerCase();
    const chat = (target.data.said || []).filter((l) => l.kind !== "whisper" || l.to === me).map(({ t, kind, text }) => ({ t, kind, text }));
    const r = await EmberReport.create({
      reporter: socket.data.username || null, reporterName: nameOf(socket),
      target: nameOf(target), targetAccount: target.data.username || null,
      reason: REASONS.includes(msg.reason) ? msg.reason : "other", note: clean(msg.note, 200), chat,
      room: String(socket.data.channel || "").slice(0, 40), zone: clean(target.data.presence.z, 16),
    });
    info(`Thanks. Your report about ${nameOf(target)} was sent to the admins.`);
    for (const s of ns.sockets.values()) if (isAdmin(s)) s.emit("modReport", { id: String(r._id), target: r.target, reason: r.reason });
  });

  // ---- admin tools
  on("modList", async () => {
    const open = await EmberReport.find({ status: "open" }).sort({ createdAt: -1 }).limit(50).lean();
    const done = await EmberReport.find({ status: "done" }).sort({ updatedAt: -1 }).limit(10).lean();
    const players = [...ns.sockets.values()].filter((s) => s.data.presence).map(playerRow).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
    socket.emit("modList", { reports: open.map(reportRow), done: done.map(reportRow), players });
  }, true);

  on("modClose", async (msg) => {
    const id = String(msg.id || "");
    if (!/^[a-f0-9]{24}$/.test(id)) return;
    await EmberReport.updateOne({ _id: id }, { status: "done", handledBy: socket.data.username, action: clean(msg.action, 40) || "closed" });
    socket.emit("modDone", { id });
  }, true);

  // the target: a live socket by peer id, or an account by username (it may be offline)
  const find = (msg) => {
    const s = msg.peer ? ns.sockets.get(String(msg.peer)) : null;
    const account = s ? s.data.username : clean(msg.account, 16).toLowerCase() || null;
    const live = account ? [...ns.sockets.values()].filter((x) => x.data.username === account) : s ? [s] : [];
    return { live, account, name: s ? nameOf(s) : account };
  };

  on("modMute", async (msg) => {
    const mins = Math.max(0, Math.min(60 * 24 * 30, Math.floor(Number(msg.minutes) || 0)));
    const { live, account, name } = find(msg);
    if (!live.length && !account) return error("That player is not online.");
    if (account && admins().has(account) && mins) return error("You cannot mute an admin.");
    const until = mins ? Date.now() + mins * 60000 : 0;
    if (account) {
      const r = await EmberAccount.updateOne({ username: account }, { mutedUntil: until ? new Date(until) : null });
      if (!r.matchedCount && !live.length) return error(`No account called ${account}.`);
    }
    for (const s of live) {
      s.data.mutedUntil = until;
      if (mins) s.emit("modMuted", { minutes: mins }); else s.emit("modMuted", { minutes: 0 });
    }
    info(mins ? `Muted ${name} for ${mins} minutes.` : `Unmuted ${name}.`);
  }, true);

  on("modKick", async (msg) => {
    const { live, account, name } = find(msg);
    if (!live.length) return error("That player is not online.");
    if (account && admins().has(account)) return error("You cannot kick an admin.");
    for (const s of live) { s.emit("modKicked", { reason: clean(msg.reason, 80) || "Removed by an admin." }); s.disconnect(true); }
    info(`Kicked ${name}.`);
  }, true);

  on("modBan", async (msg) => {
    const days = Math.max(0, Math.min(3650, Math.floor(Number(msg.days) || 0)));
    const { live, account, name } = find(msg);
    if (!account) return error("Only players with an account can be banned. Kick a guest instead.");
    if (admins().has(account)) return error("You cannot ban an admin.");
    const until = days ? new Date(Date.now() + days * 86400000) : null;
    const r = await EmberAccount.updateOne({ username: account }, { bannedUntil: until, banReason: clean(msg.reason, 80) });
    if (!r.matchedCount) return error(`No account called ${account}.`);
    if (days) for (const s of live) { s.emit("modKicked", { reason: `This account is banned for ${days} day${days === 1 ? "" : "s"}.`, banned: true }); s.disconnect(true); }
    info(days ? `Banned ${name} for ${days} days.` : `Unbanned ${account}.`);
  }, true);
}

module.exports = { attachMod, loadModeration, filterPresenceChat, chatAllowed, isAdmin, isAdminName };
