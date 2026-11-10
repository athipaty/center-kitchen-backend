// Embervale: server-run monsters.
// One ZoneSim per (room channel, region) with players in it. It moves the monsters, decides
// their attacks, checks the hits players report, and rolls drops for everyone who helped.
// The behaviour mirrors the game's own updateMob() (js/combat.js in the game repo) and the
// maps come from world.json, exported from the game by tools/export-world.js.
const WORLD = require("./world.json");

const TILE = WORLD.tile, PR = WORLD.pr, BLOCK = WORLD.block;
const ZONES = {};
for (const [id, z] of Object.entries(WORLD.zones)) ZONES[id] = { ...z, t: Buffer.from(z.t, "base64") };
const MOBS = WORLD.mobs;

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const sface = (dx, dy) => (dx - dy < 0 ? -1 : 1);
const MAX_EVENTS = 32;

class ZoneSim {
  constructor(zoneId) {
    this.id = zoneId;
    this.Z = ZONES[zoneId];
    this.now = 0;
    this.evs = [];
    this.evId = 0;
    this.mobs = [];
    for (const [type, n] of this.Z.mobs) for (let k = 0; k < n; k++) this.mobs.push(this.spawn(type));
    this.mobs.forEach((m, i) => (m.idx = i));
  }

  blocked(x, y) { const Z = this.Z; return x < 0 || y < 0 || x >= Z.w || y >= Z.h || BLOCK[Z.t[y * Z.w + x]]; }
  canStand(x, y, r) {
    const f = Math.floor;
    return !this.blocked(f((x - r) / TILE), f((y - r) / TILE)) && !this.blocked(f((x + r) / TILE), f((y - r) / TILE)) &&
      !this.blocked(f((x - r) / TILE), f((y + r) / TILE)) && !this.blocked(f((x + r) / TILE), f((y + r) / TILE));
  }
  moveEnt(e, dx, dy, r) {
    let moved = false;
    if (dx && this.canStand(e.x + dx, e.y, r)) { e.x += dx; moved = true; }
    if (dy && this.canStand(e.x, e.y + dy, r)) { e.y += dy; moved = true; }
    return moved;
  }

  spawn(type, m) {
    const Z = this.Z, i = Z.spawnTiles[Math.floor(Math.random() * Z.spawnTiles.length)], d = MOBS[type];
    const x = (i % Z.w + 0.5) * TILE, y = (((i / Z.w) | 0) + 0.5) * TILE;
    m = m || { type };
    Object.assign(m, { d, x, y, sx: x, sy: y, hp: d.hp, state: "idle", atkT: 0, wT: rnd(0, 3), tx: null, ty: null, face: 1,
      dead: false, slowUntil: 0, ail: null, ailUntil: 0, moving: false, slamT: this.now + 6, slamAt: 0, stunUntil: 0, dmg: new Map(), respawnAt: 0 });
    return m;
  }

  event(k, m, extra) {
    this.evs.push({ i: ++this.evId, k, m: m.idx, ...extra });
    if (this.evs.length > MAX_EVENTS) this.evs.splice(0, this.evs.length - MAX_EVENTS);
  }

  // A player reported a hit. Only accept it if they are near the monster and the damage is believable.
  hit(player, h) {
    const m = this.mobs[Math.floor(Number(h.m))];
    if (!m || m.dead) return;
    if (dist(player, m) > 450) return; // too far away to have hit it
    m.state = "chase";
    if (h.sl) m.slowUntil = this.now + clamp(Number(h.sl) || 0, 0, 6);
    // frozen or stunned by a skill: it cannot move or attack for a few seconds
    if (h.sk === "freeze" || h.sk === "stun") { m.ail = h.sk; m.ailUntil = this.now + clamp(Number(h.st) || 0, 0, 5); }
    const cap = 400 + clamp(Math.floor(Number(player.lv) || 1), 1, 99) * 150;
    const dmg = clamp(Math.round(Number(h.d) || 0), 0, cap);
    if (dmg <= 0) return;
    m.hp -= dmg;
    m.stunUntil = this.now + 0.22;
    m.dmg.set(player.id, (m.dmg.get(player.id) || 0) + dmg);
    if (m.hp <= 0) this.kill(m);
  }

  kill(m) {
    m.dead = true; m.hp = 0; m.slamAt = 0;
    m.respawnAt = this.now + (m.d.respawn || rnd(9, 15));
    // everyone who damaged it gets their own drops, rolled here so nobody can fake them
    for (const id of m.dmg.keys()) {
      const l = [];
      for (const [item, ch] of m.d.drops) if (Math.random() < ch) l.push(item);
      if (Math.random() < m.d.sigChance) l.push(m.type + "_sig");
      this.event("d", m, { t: id, l, g: Math.round(m.d.lv * rnd(1.5, 3)) });
    }
    m.dmg = new Map();
  }

  tick(dt, players) {
    this.now += dt;
    const targets = players.filter((p) => !p.dead);
    for (const m of this.mobs) this.updateMob(m, dt, targets);
  }

  updateMob(m, dt, T) {
    const d = m.d;
    if (m.dead) { if (this.now >= m.respawnAt) this.spawn(m.type, m); return; }
    if (m.ailUntil > this.now) { m.moving = false; return; }
    let tg = null, dp = 1e9;
    for (const t of T) { const q = dist(m, t); if (q < dp) { dp = q; tg = t; } }
    const slow = m.slowUntil > this.now ? 0.4 : 1;
    if (m.slamAt) { if (this.now >= m.slamAt) { m.slamAt = 0; m.slamT = this.now + 7; this.event("s", m); } return; }
    if (!tg) { if (m.state === "chase") m.state = "idle"; }
    else if (m.state !== "chase" && d.aggro && dp < 170) m.state = "chase";
    if (m.state === "chase" && tg) {
      if (Math.hypot(m.x - m.sx, m.y - m.sy) > 520 || dp > 600) m.state = "return";
      else {
        if (d.boss && this.now > m.slamT && dp < 160) { m.slamAt = this.now + 1.1; this.event("w", m); return; }
        const reach = d.range + d.size + PR + 4;
        m.atkT -= dt;
        if (dp <= reach) {
          m.face = sface(tg.x - m.x, tg.y - m.y); m.moving = false;
          if (m.atkT <= 0) { m.atkT = d.boss ? 1.3 : 1.6; this.event("a", m, { t: tg.id }); }
        } else if (!(m.stunUntil > this.now)) {
          const dx = tg.x - m.x, dy = tg.y - m.y, n = Math.hypot(dx, dy) || 1, s = d.spd * slow * dt * 1.15;
          this.moveEnt(m, (dx / n) * s, (dy / n) * s, Math.min(d.size * 0.6, 11)); m.face = sface(dx, dy); m.moving = true;
        }
      }
    }
    if (m.state === "return") {
      const dx = m.sx - m.x, dy = m.sy - m.y, n = Math.hypot(dx, dy);
      if (n < 8) { m.state = "idle"; m.hp = d.hp; m.dmg = new Map(); }
      else {
        const s = d.spd * 1.6 * dt;
        if (!this.moveEnt(m, (dx / n) * s, (dy / n) * s, Math.min(d.size * 0.6, 11))) { m.x = m.sx; m.y = m.sy; }
        m.hp = Math.min(d.hp, m.hp + d.hp * dt * 0.5);
      }
    }
    if (m.state === "idle") {
      m.moving = false; m.wT -= dt;
      if (m.tx !== null) {
        const dx = m.tx - m.x, dy = m.ty - m.y, n = Math.hypot(dx, dy);
        if (n < 3) m.tx = null;
        else {
          const s = d.spd * 0.45 * slow * dt;
          if (!this.moveEnt(m, (dx / n) * Math.min(s, n), (dy / n) * Math.min(s, n), Math.min(d.size * 0.6, 11))) m.tx = null;
          m.face = sface(dx, dy); m.moving = true;
        }
      }
      if (m.wT <= 0) {
        m.wT = rnd(2, 5);
        if (Math.hypot(m.x - m.sx, m.y - m.sy) > 150) { m.tx = m.sx; m.ty = m.sy; }
        else { m.tx = m.x + rnd(-80, 80); m.ty = m.y + rnd(-80, 80); }
      }
    }
  }

  // Same compact format the game already uses between players: [x, y, hp per mille, flags].
  snapshot() {
    return this.mobs.map((m) => [Math.round(m.x), Math.round(m.y), m.dead ? 0 : Math.round(clamp(m.hp / m.d.hp, 0, 1) * 1000),
      (m.dead ? 1 : 0) | (m.moving ? 2 : 0) | (m.face < 0 ? 4 : 0) | (m.state === "chase" ? 8 : 0) | (m.slowUntil > this.now ? 16 : 0) |
      (m.ailUntil > this.now ? (m.ail === "freeze" ? 32 : 64) : 0)]);
  }
}

const hasSim = (zoneId) => !!ZONES[zoneId] && !ZONES[zoneId].safe;

module.exports = { ZoneSim, hasSim, WORLD_VERSION: WORLD.version };
