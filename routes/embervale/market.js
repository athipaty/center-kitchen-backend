// Embervale market board: list items for sale and buy them any time, even while the seller is offline.
// The server holds listed items; a purchase deletes the listing atomically (so two buyers can never get
// the same item) and adds the price to the seller's purse, which they claim the next time they open the
// board. Listing needs an account (the item must be stored safely); guests can browse and buy.
// Every handler is wrapped and rate limited so a bad message only fails that socket.
const mongoose = require("mongoose");
const { EmberListing, EmberPurse } = require("../../models/embervale/EmberMarket");

const MSGS_PER_SEC = 4;
const MAX_LISTINGS = 8;     // per account
const BOARD_SIZE = 120;     // newest listings sent to the board
const MAX_GOLD = 1e9;
const LOG_KEEP = 20;

const clean = (t, n) => String(t ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, n);
const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
const nameOf = (s) => clean(s?.data?.presence?.n, 16) || "Traveller";
// an item as the game stores it: a stack {id, n} or a single piece of gear {id, s: [sigils], r: refine}
function entry(e) {
  if (!e || typeof e !== "object") return null;
  const id = clean(e.id, 24);
  if (!/^[a-z0-9_]+$/.test(id)) return null;
  if (e.n !== undefined) { const n = int(e.n, 30000); return n >= 1 ? { id, n } : null; }
  return { id, s: (Array.isArray(e.s) ? e.s : []).slice(0, 4).map((x) => (x == null ? null : clean(x, 24))), r: int(e.r, 10) };
}
const pub = (l, me) => ({ k: String(l._id), e: l.e, price: l.price, seller: l.sellerName || "Someone", mine: !!me && l.seller === me, at: +new Date(l.createdAt) });

function attachMarket(socket, ns) {
  let tokens = MSGS_PER_SEC, last = Date.now();
  const allow = () => {
    const now = Date.now();
    tokens = Math.min(MSGS_PER_SEC, tokens + ((now - last) / 1000) * MSGS_PER_SEC);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
  const user = () => socket.data.username;
  const fail = (text, extra) => socket.emit("mkError", { error: text, ...(extra || {}) });
  const on = (ev, fn) => socket.on(ev, async (msg) => {
    const m = msg && typeof msg === "object" ? msg : {};
    try {
      if (!allow()) return fail("Too fast. Try again in a moment.", { ref: clean(m.ref, 24), back: entry(m.e) });
      await fn(m);
    } catch { fail("Something went wrong with the market. Try again.", { ref: clean(m.ref, 24), back: ev === "mkPost" ? entry(m.e) : null }); }
  });

  // the board: newest listings, plus my listings and purse when I have an account
  async function board() {
    const me = user();
    const items = await EmberListing.find({}).sort({ createdAt: -1 }).limit(BOARD_SIZE).lean();
    let mine = [], purse = null;
    if (me) {
      mine = await EmberListing.find({ seller: me }).sort({ createdAt: -1 }).lean();
      const p = await EmberPurse.findOne({ seller: me }).lean();
      purse = { gold: p?.gold || 0, log: (p?.log || []).slice(-LOG_KEEP).reverse() };
    }
    socket.emit("mkBoard", { items: items.map((l) => pub(l, me)), mine: mine.map((l) => pub(l, me)), purse, account: !!me, max: MAX_LISTINGS });
  }
  on("mkBrowse", board);

  // put an item up for sale (the game has already taken it out of the bag; on any failure it gets it back)
  on("mkPost", async (m) => {
    const e = entry(m.e), price = int(m.price, MAX_GOLD), ref = clean(m.ref, 24);
    if (!user()) return fail("Selling on the market needs an account. Log in from the title screen.", { ref, back: e });
    if (!e || price < 1) return fail("That cannot be listed.", { ref, back: e });
    const n = await EmberListing.countDocuments({ seller: user() });
    if (n >= MAX_LISTINGS) return fail(`You can list at most ${MAX_LISTINGS} items at a time.`, { ref, back: e });
    const l = await EmberListing.create({ seller: user(), sellerName: nameOf(socket), e, price });
    socket.emit("mkPosted", { ref, k: String(l._id) });
    await board();
  });

  // buy: the listing is removed in one step, so only one buyer can ever get it
  on("mkBuy", async (m) => {
    const k = clean(m.k, 32), price = int(m.price, MAX_GOLD);
    if (!mongoose.isValidObjectId(k)) return fail("That item is no longer for sale.");
    const q = { _id: k, price };
    if (user()) q.seller = { $ne: user() };
    const l = await EmberListing.findOneAndDelete(q).lean();
    if (!l) { await board(); return fail("That item was just sold or its price changed."); }
    const buyer = nameOf(socket);
    await EmberPurse.updateOne({ seller: l.seller },
      { $inc: { gold: l.price }, $push: { log: { $each: [{ e: l.e, price: l.price, buyer, at: new Date() }], $slice: -LOG_KEEP } } },
      { upsert: true });
    socket.emit("mkBought", { e: l.e, price: l.price, seller: l.sellerName });
    for (const s of ns.sockets.values()) if (s !== socket && s.data.username === l.seller) s.emit("mkSold", { e: l.e, price: l.price, buyer });
    await board();
  });

  // take an unsold item back
  on("mkCancel", async (m) => {
    const k = clean(m.k, 32);
    if (!user() || !mongoose.isValidObjectId(k)) return;
    const l = await EmberListing.findOneAndDelete({ _id: k, seller: user() }).lean();
    if (!l) { await board(); return fail("That item is no longer listed."); }
    socket.emit("mkReturned", { e: l.e });
    await board();
  });

  // collect the gold from sales
  on("mkClaim", async () => {
    if (!user()) return;
    const p = await EmberPurse.findOneAndUpdate({ seller: user(), gold: { $gt: 0 } }, { $set: { gold: 0 } }, { returnDocument: "before" }).lean();
    if (p && p.gold > 0) socket.emit("mkClaimed", { gold: p.gold });
    await board();
  });
}

module.exports = { attachMarket };
