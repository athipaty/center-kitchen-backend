// Embervale party voice chat (game v1.52.0+). The voice itself goes straight between the players' browsers (WebRTC);
// the server only passes the connection setup ("vcSig": offers, answers, network candidates) between two members of the
// same party who have both joined voice, and tells the party who is in voice ("vcState"). Every handler is wrapped so a
// bad message only fails that socket.
const { getParty } = require("./social");

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
    socket.data.vc = true; socket.data.vcParty = socket.data.partyId; vcBroadcast(ns, socket.data.partyId);
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

module.exports = { attachVoice, vcBroadcast };
