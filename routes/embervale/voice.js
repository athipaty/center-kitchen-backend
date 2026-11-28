// Embervale party voice chat (game v1.52.0+). The voice itself goes straight between the players' browsers (WebRTC);
// the server only passes the connection setup ("vcSig": offers, answers, network candidates) between two members of the
// same party who have both joined voice, and tells the party who is in voice ("vcState"). Every handler is wrapped so a
// bad message only fails that socket.
const { getParty } = require("./social");

/* ---- relay (TURN) servers ----
   Phones on many mobile networks (shared addresses) cannot reach each other directly; a relay carries their voice.
   Set ONE of these on the server (Render → Environment), nothing else needed in the game:
     Cloudflare (free tier):  EMBER_TURN_CF_KEY_ID, EMBER_TURN_CF_TOKEN   (a TURN key from Cloudflare Realtime)
     any TURN service:        EMBER_TURN_URLS (comma separated, e.g. turn:x.com:3478,turns:x.com:5349),
                              EMBER_TURN_USERNAME, EMBER_TURN_CREDENTIAL
   Without them voice still works for players whose networks allow direct connections. */
let iceCache = null, iceAt = 0;
async function relayServers() {
  const env = process.env;
  if (env.EMBER_TURN_CF_KEY_ID && env.EMBER_TURN_CF_TOKEN) {
    if (iceCache && Date.now() - iceAt < 6 * 3600 * 1000) return iceCache; // short-lived credentials, renewed every 6 h (valid 24 h)
    // the newer "generate-ice-servers" first (a list), then the older "generate" (one entry); browsers stall on port 53, so those urls go
    const key = encodeURIComponent(env.EMBER_TURN_CF_KEY_ID.trim());
    for (const path of ["generate-ice-servers", "generate"]) {
      try {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${key}/credentials/${path}`, {
          method: "POST", headers: { Authorization: `Bearer ${env.EMBER_TURN_CF_TOKEN.trim()}`, "Content-Type": "application/json" }, body: JSON.stringify({ ttl: 86400 }) });
        if (r.ok) {
          const j = await r.json(); const raw = j && j.iceServers; const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
          const ice = list.map((e) => ({ ...e, urls: [].concat(e.urls || []).filter((u) => !/:53(\?|$)/.test(u)) })).filter((e) => e.urls.length);
          if (ice.length) { iceCache = ice; iceAt = Date.now(); return iceCache; }
        }
        console.warn(`embervale voice: Cloudflare TURN ${path} failed`, r.status,
          r.status === 404 ? "(EMBER_TURN_CF_KEY_ID is not a TURN key id: use the Turn Token ID, not the API token or account id)" :
          r.status === 401 || r.status === 403 ? "(EMBER_TURN_CF_TOKEN is wrong: use the API token shown with the TURN key)" : "");
      } catch (e) { console.warn("embervale voice: Cloudflare TURN credentials failed", e.message); }
    }
    return iceCache || [];
  }
  if (env.EMBER_TURN_URLS && env.EMBER_TURN_USERNAME && env.EMBER_TURN_CREDENTIAL)
    return [{ urls: env.EMBER_TURN_URLS.split(",").map((u) => u.trim()).filter(Boolean), username: env.EMBER_TURN_USERNAME, credential: env.EMBER_TURN_CREDENTIAL }];
  return [];
}

const MAX_SIG = 16000;      // an offer or answer is a few kB; anything bigger is not one
const SIGS_PER_SEC = 40;    // setup with a few party members sends a burst of candidates, then nothing

// tell everyone in the party who is in voice (members who left the party are dropped)
function vcBroadcast(ns, partyId) {
  const p = getParty(partyId); if (!p) return;
  const inVoice = [...p.members].filter((id) => { const s = ns.sockets.get(id); return s && s.data.vc && s.data.partyId === partyId; });
  for (const id of p.members) { const s = ns.sockets.get(id); if (s) s.emit("vcState", { peers: inVoice }); }
}

function attachVoice(socket, ns) {
  const on = (ev, fn) => socket.on(ev, (msg) => { try { fn(msg && typeof msg === "object" ? msg : {}); } catch { /* ignore bad message */ } });
  let tokens = SIGS_PER_SEC, last = Date.now();
  on("vcJoin", () => {
    if (!socket.data.partyId) { socket.emit("vcState", { peers: [], why: "Join a party first to use voice." }); return; }
    socket.data.vc = true; socket.data.vcParty = socket.data.partyId;
    // the relay list first, so the game has it before it opens any connection (game v1.60.3+ reads "vcIce")
    relayServers().then((ice) => { try { socket.emit("vcIce", { iceServers: ice }); } catch { /* gone */ } })
      .finally(() => { try { if (socket.data.vc) vcBroadcast(ns, socket.data.partyId); } catch { /* ignore */ } });
  });
  on("vcLeave", () => { const pid = socket.data.vcParty || socket.data.partyId; socket.data.vc = false; socket.data.vcParty = null; if (pid) vcBroadcast(ns, pid); });
  on("vcState", () => { if (socket.data.partyId) vcBroadcast(ns, socket.data.partyId); else socket.emit("vcState", { peers: [] }); });
  on("vcSig", (msg) => {
    const now = Date.now(); tokens = Math.min(SIGS_PER_SEC, tokens + ((now - last) / 1000) * SIGS_PER_SEC); last = now;
    if (tokens < 1) return; tokens -= 1;
    const t = ns.sockets.get(String(msg.to || ""));
    if (!t || t.id === socket.id || !socket.data.vc || !t.data.vc) return;
    if (!socket.data.partyId || socket.data.partyId !== t.data.partyId) return;
    const d = msg.d; if (!d || typeof d !== "object") return;
    if (JSON.stringify(d).length > MAX_SIG) return;
    t.emit("vcSig", { from: socket.id, d });
  });
  socket.on("disconnect", () => { try { const pid = socket.data.vcParty || socket.data.partyId; if (socket.data.vc && pid) { socket.data.vc = false; vcBroadcast(ns, pid); } } catch { /* ignore */ } });
}

module.exports = { attachVoice, vcBroadcast, relayServers };
