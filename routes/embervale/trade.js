// Embervale trading and player shops. The server is the referee: it holds both sides of a
// trade and only completes it when both players have locked their offer and pressed Trade,
// and it keeps shop stock counts so two buyers can never get the same last item.
// Every handler is wrapped and rate limited so a bad message only fails that socket.
const MSGS_PER_SEC = 8;
const NEAR = 400;          // players must stand this close to trade or buy
const MAX_OFFER = 10;      // items per side of a trade
const MAX_SHOP = 12;       // listings per shop
const MAX_GOLD = 1e9;

const trades = new Map();  // socket id -> trade (both members point at the same object)
const shops = new Map();   // socket id -> { title, items: Map<k, { k, e, n, price }> }

const clean = (t, n) => String(t ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, n);
const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
const nameOf = (s) => clean(s?.data?.presence?.n, 16) || "Traveller";
const near = (a, b) => {
  const p = a?.data?.presence, q = b?.data?.presence;
  return !!(p && q && p.z === q.z && Math.hypot((+p.x || 0) - (+q.x || 0), (+p.y || 0) - (+q.y || 0)) <= NEAR);
};
// an item as the game stores it: a stack {id, n} or a single piece of gear {id, s: [sigils], r: refine}
function entry(e) {
  if (!e || typeof e !== "object") return null;
  const id = clean(e.id, 24);
  if (!/^[a-z0-9_]+$/.test(id)) return null;
  if (e.n !== undefined) { const n = int(e.n, 30000); return n >= 1 ? { id, n } : null; }
  return { id, s: (Array.isArray(e.s) ? e.s : []).slice(0, 4).map((x) => (x == null ? null : clean(x, 24))), r: int(e.r, 10) };
}
const blankOffer = () => ({ items: [], gold: 0, locked: false, ok: false });

function attachTrade(socket, ns) {
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
  const error = (s, text) => s?.emit("socialError", { error: text });

  // ---------------- trading ----------------
  const other = (t, sid) => (t.a === sid ? t.b : t.a);
  const sendState = (t) => {
    for (const sid of [t.a, t.b]) {
      const o = other(t, sid);
      ns.sockets.get(sid)?.emit("tradeState", { peer: o, name: nameOf(ns.sockets.get(o)), me: t.off[sid], them: t.off[o] });
    }
  };
  const closeTrade = (t, reason) => {
    trades.delete(t.a); trades.delete(t.b);
    for (const sid of [t.a, t.b]) ns.sockets.get(sid)?.emit("tradeClosed", { reason });
  };
  const busy = (s) => trades.has(s.id) || shops.has(s.id);

  on("tradeRequest", (msg) => {
    const target = ns.sockets.get(String(msg.peer));
    if (!target || target === socket || !target.data.presence) return error(socket, "That player is not here.");
    if (target.data.channel !== socket.data.channel || !near(socket, target)) return error(socket, `Stand next to ${nameOf(target)} to trade.`);
    if (busy(socket)) return error(socket, "Finish your current trade or close your shop first.");
    if (busy(target)) return error(socket, `${nameOf(target)} is busy.`);
    (target.data.tradeAsks ||= new Map()).set(socket.id, Date.now());
    target.emit("tradeRequest", { fromPeer: socket.id, from: nameOf(socket) });
    socket.emit("socialInfo", { info: `Asked ${nameOf(target)} to trade.` });
  });
  on("tradeAccept", (msg) => {
    const from = ns.sockets.get(String(msg.peer)), at = socket.data.tradeAsks?.get(String(msg.peer));
    socket.data.tradeAsks?.delete(String(msg.peer));
    if (!from || !at || Date.now() - at > 60_000) return error(socket, "That trade request has expired.");
    if (busy(socket) || busy(from)) return error(socket, "One of you is busy.");
    if (!near(socket, from)) return error(socket, `Stand next to ${nameOf(from)} to trade.`);
    const t = { a: from.id, b: socket.id, off: { [from.id]: blankOffer(), [socket.id]: blankOffer() } };
    trades.set(t.a, t); trades.set(t.b, t);
    sendState(t);
  });
  on("tradeDecline", (msg) => {
    socket.data.tradeAsks?.delete(String(msg.peer));
    ns.sockets.get(String(msg.peer))?.emit("socialInfo", { info: `${nameOf(socket)} declined to trade.` });
  });
  on("tradeOffer", (msg) => {
    const t = trades.get(socket.id);
    if (!t || t.off[socket.id].locked) return;
    const items = (Array.isArray(msg.items) ? msg.items : []).slice(0, MAX_OFFER).map(entry).filter(Boolean);
    Object.assign(t.off[socket.id], { items, gold: int(msg.gold, MAX_GOLD) });
    sendState(t);
  });
  on("tradeLock", () => { const t = trades.get(socket.id); if (!t) return; t.off[socket.id].locked = true; sendState(t); });
  on("tradeConfirm", () => {
    const t = trades.get(socket.id);
    if (!t || !t.off[t.a].locked || !t.off[t.b].locked) return;
    t.off[socket.id].ok = true;
    if (!(t.off[t.a].ok && t.off[t.b].ok)) { sendState(t); return; }
    trades.delete(t.a); trades.delete(t.b);
    for (const sid of [t.a, t.b]) {
      const o = other(t, sid);
      ns.sockets.get(sid)?.emit("tradeDone", { name: nameOf(ns.sockets.get(o)), give: t.off[sid], get: t.off[o] });
    }
  });
  on("tradeCancel", () => { const t = trades.get(socket.id); if (t) closeTrade(t, `${nameOf(socket)} cancelled the trade.`); });

  // ---------------- player shops ----------------
  on("vendOpen", (msg) => {
    if (busy(socket)) return error(socket, "Finish your trade or close your shop first.");
    const items = new Map();
    let k = 0;
    for (const it of (Array.isArray(msg.items) ? msg.items : []).slice(0, MAX_SHOP)) {
      const e = entry(it?.e), price = int(it?.price, MAX_GOLD);
      if (!e || price < 1) continue;
      const n = e.n || 1;
      delete e.n;
      items.set(++k, { k, e, n, price, stack: it.e.n !== undefined });
    }
    if (!items.size) return error(socket, "Add at least one item with a price.");
    shops.set(socket.id, { title: clean(msg.title, 30) || `${nameOf(socket)}'s shop`, items });
    socket.emit("vendOpened", { keys: [...items.keys()] });
  });
  on("vendClose", () => { shops.delete(socket.id); socket.emit("vendClosed", { reason: "" }); });
  const listOf = (sid) => {
    const shop = shops.get(sid);
    return shop && { peer: sid, title: shop.title, seller: nameOf(ns.sockets.get(sid)),
      items: [...shop.items.values()].map((it) => ({ k: it.k, e: it.stack ? { ...it.e, n: it.n } : it.e, price: it.price })) };
  };
  on("vendView", (msg) => {
    const seller = ns.sockets.get(String(msg.peer));
    if (!seller || !shops.has(seller.id) || seller.data.channel !== socket.data.channel) return error(socket, "That shop is closed.");
    socket.emit("vendList", listOf(seller.id));
  });
  on("vendBuy", (msg) => {
    const seller = ns.sockets.get(String(msg.peer)), shop = seller && shops.get(seller.id);
    if (!shop || seller === socket) return error(socket, "That shop is closed.");
    if (!near(socket, seller)) return error(socket, `Walk up to ${nameOf(seller)}'s shop to buy.`);
    const it = shop.items.get(int(msg.k, 1e6));
    if (!it) return error(socket, "That item has just been sold.");
    const n = Math.max(1, Math.min(it.n, int(msg.n, 30000) || 1));
    it.n -= n;
    if (it.n <= 0) shop.items.delete(it.k);
    const gold = it.price * n;
    seller.emit("vendSold", { k: it.k, n, gold, buyer: nameOf(socket) });
    socket.emit("vendBought", { e: it.stack ? { ...it.e, n } : it.e, n, gold, seller: nameOf(seller) });
    if (!shop.items.size) { shops.delete(seller.id); seller.emit("vendClosed", { reason: "Your shop sold out." }); socket.emit("vendList", null); }
    else socket.emit("vendList", listOf(seller.id));
  });

  socket.on("disconnect", () => {
    try {
      const t = trades.get(socket.id);
      if (t) closeTrade(t, `${nameOf(socket)} left, so the trade was cancelled.`);
      shops.delete(socket.id);
    } catch { /* ignore */ }
  });
}

module.exports = { attachTrade };
