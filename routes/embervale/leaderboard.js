// Embervale leaderboards (GET /api/embervale/leaderboard): the top 50 in four lists (highest level, monsters and bosses
// this season, richest) and last season's Hall of Fame. Read-only. Every saved character is read at most once a minute
// (only the few fields the lists need) and the result is cached, so many players opening the board cost one read.
// Logged in (Bearer token) with ?slot=n, your own rows are marked and your place is given even past the top 50.
const express = require("express");
const EmberAccount = require("../../models/embervale/EmberAccount");
const { verifyEmbervaleToken } = require("../../utils/embervaleAuth");
const { board } = require("./leaderboardCore");

const router = express.Router();
const CACHE_MS = 60_000;
let cache = { at: 0, accounts: null, loading: null };
const FIELDS = ["name", "lv", "jl", "cls", "reborn", "gold", "ls", "lsPrev"];
const proj = { bannedUntil: 1 };
for (let n = 0; n < 6; n++) { const f = n ? "character" + n : "character"; for (const k of FIELDS) proj[`${f}.p.${k}`] = 1; }

async function accounts() {
  if (cache.accounts && Date.now() - cache.at < CACHE_MS) return cache.accounts;
  if (!cache.loading) cache.loading = EmberAccount.find({}, proj).lean().then((a) => { cache = { at: Date.now(), accounts: a, loading: null }; return a; })
    .catch((e) => { cache.loading = null; throw e; });
  return cache.loading;
}

function whoAmI(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  try { const t = verifyEmbervaleToken(h.slice(7)); const slot = Math.floor(Number(req.query.slot) || 0); return t && t.id && slot >= 0 && slot < 6 ? { acct: t.id, slot } : null; }
  catch { return null; }
}

router.get("/leaderboard", async (req, res) => {
  try { res.json(board(await accounts(), Date.now(), whoAmI(req))); }
  catch { res.status(500).json({ error: "Could not load the leaderboard" }); }
});

module.exports = { leaderboardRouter: router, _resetLeaderboardCache: () => { cache = { at: 0, accounts: null, loading: null }; } };
