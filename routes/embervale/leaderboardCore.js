// Embervale leaderboards: rank every saved character (all six slots of every account) in four lists.
// Pure functions, no database, so they can be tested on their own (routes/embervale/leaderboard.js does the reading).
//   level   highest level (rebirth first, then base level, then job level), all time
//   kills   monsters defeated this season          (the character's own count, p.ls = { s: "2026-11", k, b })
//   bosses  bosses and mini-bosses defeated this season
//   gold    gold carried, all time
// A season is a calendar month in Thailand time (UTC+7). When a month ends the game moves p.ls to p.lsPrev, so last
// month's numbers are still there for the Hall of Fame (top 3 of last season in kills and bosses).
const CATS = ["level", "kills", "bosses", "gold"];
const TOP = 50;

function seasonOf(ms) { const d = new Date(ms + 7 * 3600e3); return d.toISOString().slice(0, 7); }
function prevSeason(s) { const [y, m] = s.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; }

const num = (v, max) => { const n = Math.floor(Number(v) || 0); return n < 0 ? 0 : n > max ? max : n; };
const clean = (t, n) => String(t ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, n);

// one row per character: what each list ranks by (null when it does not take part in that list)
function rowOf(p, accountId, slot, season) {
  if (!p || typeof p !== "object" || typeof p.name !== "string") return null;
  const cur = p.ls && typeof p.ls === "object" && p.ls.s === season ? p.ls : null;
  const prevS = prevSeason(season);
  const prev = p.lsPrev && p.lsPrev.s === prevS ? p.lsPrev : p.ls && p.ls.s === prevS ? p.ls : null;
  return {
    acct: String(accountId), slot, name: clean(p.name, 16) || "Traveller", cls: clean(p.cls, 20), lv: num(p.lv, 99), jl: num(p.jl, 99), reborn: p.reborn ? 1 : 0,
    level: num(p.reborn ? 1 : 0, 1) * 1e6 + num(p.lv, 99) * 1e3 + num(p.jl, 99),
    kills: cur ? num(cur.k, 1e8) : 0, bosses: cur ? num(cur.b, 1e7) : 0, gold: num(p.gold, 1e10),
    prevKills: prev ? num(prev.k, 1e8) : 0, prevBosses: prev ? num(prev.b, 1e7) : 0,
  };
}

// accounts: [{ _id, bannedUntil, character, character1 ... character5 }]
function rowsOf(accounts, season, now) {
  const rows = [];
  for (const a of accounts || []) {
    if (!a || (a.bannedUntil && new Date(a.bannedUntil).getTime() > now)) continue; // banned players are not ranked
    for (let n = 0; n < 6; n++) { const c = a[n ? "character" + n : "character"]; const r = rowOf(c && c.p, a._id, n, season); if (r) rows.push(r); }
  }
  return rows;
}

// the public part of a row (no account id)
const pub = (r, rank, val) => ({ rank, name: r.name, cls: r.cls, lv: r.lv, reborn: r.reborn, v: val });

function rank(rows, key) {
  const list = rows.filter((r) => key === "level" || key === "gold" || r[key] > 0);
  list.sort((a, b) => b[key] - a[key] || a.name.localeCompare(b.name));
  return list;
}

// the whole board; me = { acct, slot } marks your own rows and gives your place when you are past the top 50
function board(accounts, now, me) {
  const season = seasonOf(now), rows = rowsOf(accounts, season, now), out = { season, prev: prevSeason(season), lists: {}, hall: {}, me: {} };
  for (const k of CATS) {
    const list = rank(rows, k), val = (r) => (k === "level" ? r.lv : r[k]);
    out.lists[k] = list.slice(0, TOP).map((r, i) => ({ ...pub(r, i + 1, val(r)), me: !!me && r.acct === String(me.acct) && r.slot === me.slot }));
    if (me) { const i = list.findIndex((r) => r.acct === String(me.acct) && r.slot === me.slot); if (i >= 0) out.me[k] = { rank: i + 1, v: val(list[i]), of: list.length }; }
  }
  for (const k of ["kills", "bosses"]) {
    const key = k === "kills" ? "prevKills" : "prevBosses", list = rank(rows, key).slice(0, 3);
    out.hall[k] = list.map((r, i) => ({ ...pub(r, i + 1, r[key]), me: !!me && r.acct === String(me.acct) && r.slot === me.slot }));
  }
  return out;
}

module.exports = { CATS, TOP, seasonOf, prevSeason, rowOf, rowsOf, board };
