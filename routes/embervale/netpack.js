// Embervale: smaller monster updates. A region's monsters are a list of [x, y, hp, flags] (sim.js snapshot). Between
// full lists (every MOB_FULL_MS) only the monsters that changed are sent, as [index, x, y, hp, flags]; a game that
// does not know this yet (no "dz" in its presence) keeps getting full lists.
const MOB_FULL_MS = 2000; // a full list at least this often (and at once for a player who arrives or comes back)
const MOB_IDLE_MS = 1000; // nothing changed: one small "still here" update a second (the game drops monsters after 3 s)

// the changed monsters, or null when the lists cannot be compared (different length: send a full list)
function mobDelta(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return null;
  const out = [];
  for (let i = 0; i < next.length; i++) {
    const a = prev[i], b = next[i];
    if (!a || !b || a.length !== b.length || a.some((v, k) => v !== b[k])) out.push([i, ...b]);
  }
  return out;
}

module.exports = { MOB_FULL_MS, MOB_IDLE_MS, mobDelta };
