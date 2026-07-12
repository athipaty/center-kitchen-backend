// server.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const { createServer } = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const rateLimit = require('express-rate-limit');
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
app.set('io', io);

// Requests pass through two proxy hops before reaching this process:
// Cloudflare's edge (fronts all *.onrender.com domains), then Render's own
// internal proxy. Trusting only 1 hop made Express read Cloudflare's edge
// IP -- which varies per request/PoP -- as the client, silently fragmenting
// every IP-keyed rate limiter below across many keys instead of one.
app.set('trust proxy', 2);

// Rate limiters
const addProductLimiter = rateLimit({ windowMs: 60_000, max: 15, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many add requests — slow down' } });
const checkLimiter      = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many check requests — slow down' } });

/* =====================
   MIDDLEWARE
===================== */
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://athipaty-center-kitchen-frontend.vercel.app",
      "https://supplier-nine.vercel.app",
      "https://milk-tracker-rho-topaz.vercel.app",
      "https://wc7fr.csb.app",
      "https://frtstock.vercel.app",
      "https://productportal-jade.vercel.app",
      "https://frtforecast.vercel.app",
      "https://sgostock.vercel.app",
      "https://expense-six-red.vercel.app",
      "https://maesaiphayao.vercel.app",
      "https://my-react-app-eight-rust.vercel.app",
      "https://tong-alpha.vercel.app",
      "https://amazon-theta-liard.vercel.app",
      "https://puthailand.vercel.app",
      "https://egp-steel.vercel.app",
      "https://youtube-tan-sigma.vercel.app",
    ],
    credentials: true,
  }),
);
app.use(express.json());

/* =====================
   ROUTES
===================== */
// --- ABT ---
app.use('/api/abt', require('./routes/abt'));

// --- Expense ---
app.use('/api/expenses',   require('./routes/expense/expenses'));
app.use('/api/fixed-bills',require('./routes/expense/fixedBills'));
app.use('/api/income',     require('./routes/expense/income'));

// --- Forecast ---
app.use('/api/forecast', require('./routes/forecast'));

// --- Milk ---
app.use('/api/milk', require('./routes/milk'));

// --- Product Portal ---
app.use('/api/products', require('./routes/productportal'));

// --- Stock ---
app.use('/api/stock', require('./routes/stock'));

// --- Supplier ---
app.use('/suppliers', require('./routes/supplier'));

// --- Inventory ---
app.use('/upload',              require('./routes/inventory/upload'));
app.use('/count',               require('./routes/inventory/count'));
app.use('/catalog',             require('./routes/inventory/catalog'));
app.use('/api/inventory-filter',require('./routes/inventory/filter'));

// --- Recipe ---
app.use('/api/recipes',     require('./routes/recipe/recipes'));
app.use('/api/ingredients', require('./routes/recipe/ingredients'));

// --- Shared ---
app.use('/auth', require('./routes/shared/auth'));

// --- Accounting (Express) ---
app.use('/api/accounting/auth',      require('./routes/accounting/auth'));
app.use('/api/accounting/gl',        require('./routes/accounting/gl'));
app.use('/api/accounting/accounts',  require('./routes/accounting/accounts'));
app.use('/api/accounting/materials', require('./routes/accounting/materials'));
app.use('/api/accounting/fgcost',    require('./routes/accounting/fgcost'));
app.use('/api/accounting/contact',   require('./routes/accounting/contact'));

// --- Amazon Tracker ---
app.post('/api/tracker',            addProductLimiter);
app.post('/api/tracker/check',      checkLimiter);
app.post('/api/tracker/check/:id',  checkLimiter);
app.use('/api/tracker', require('./routes/tracker'));
app.use('/api/orders', require('./routes/tracker/orders'));

// --- eBay ---
const ebayRouter = require('./routes/ebay');
app.use('/api/ebay', ebayRouter);
mongoose.connection.once('open', () => ebayRouter.setIo(io));

// --- Youtube (motion-comic series generator) ---
app.use('/api/youtube', require('./routes/youtube'));

/* =====================
   DATABASE
===================== */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB");
    require("./jobs/trackerScheduler").start(io);
    require("./jobs/youtubeEpisodeScheduler").start(io);
    require("./jobs/egpCacheRefresh").start();
    // egpPhayaoRefresh disabled — the nationwide RSS it scans is too sparse for the
    // keyword-match approach to ever reliably find Phayao items (0 hits after 24+
    // cycles), and the RSS doesn't accept the moiId province filter (confirmed by
    // testing it directly). Needs either the gov open-data API (blocked by WAF at
    // registration) or CAPTCHA-gated search automation to actually fix.
    // require("./jobs/egpPhayaoRefresh").start();
  })
  .catch((err) => console.error("❌ MongoDB connection error:", err));

/* =====================
   HEALTH CHECK
===================== */
app.get("/", (req, res) => res.send("API is running 🚀")); // health check

/* =====================
   START SERVER
===================== */
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
