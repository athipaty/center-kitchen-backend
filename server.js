// server.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();
const { startPriceChecker } = require("./jobs/priceChecker");

const app = express();

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
      "https://inventory-ten-omega.vercel.app",
      "https://milk-tracker-rho-topaz.vercel.app",
      "https://wc7fr.csb.app",
      "https://frtstock.vercel.app",
      "https://productportal-jade.vercel.app",
      "https://frtforecast.vercel.app",
      "https://sgostock.vercel.app",
      "https://expense-six-red.vercel.app",
    ],
    credentials: true,
  }),
);
app.use(express.json());

/* =====================
   ROUTES
===================== */
app.use("/orders", require("./routes/orders"));
app.use("/outlets", require("./routes/outlets"));
app.use("/sauces", require("./routes/sauces"));
app.use("/api/products", require("./routes/product"));
app.use("/inventory", require("./routes/inventory"));
app.use("/suppliers", require("./routes/suppliers"));
app.use("/api/milk", require("./routes/milkRoutes"));
app.use("/upload", require("./routes/upload"));
app.use("/count", require("./routes/count"));
app.use("/catalog", require("./routes/catalog"));
app.use("/auth", require("./routes/auth"));
app.use("/api/forecast", require("./routes/forecast"));
app.use("/api/search", require("./routes/arb_search"));
app.use("/api/watchlist", require("./routes/arb_watchlist"));
app.use("/api/monitor", require("./routes/arb_monitor"));
app.use("/api/scrape", require("./routes/arb_scrape"));
app.use("/api/compare", require("./routes/arb_ebay_scrape"));
app.use("/api/ebay-search", require("./routes/arb_ebay_api").router);
app.use('/api/stock', require('./routes/stock'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/fixed-bills', require('./routes/fixedBills'));
app.use('/api/income', require('./routes/income'));

/* =====================
   DATABASE
===================== */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB");
    startPriceChecker(); // 👈 add this line
  })
  .catch((err) => console.error("❌ MongoDB connection error:", err));

/* =====================
   HEALTH CHECK
===================== */
app.get("/", (req, res) => {
  res.send("API is running 🚀");
});

/* =====================
   START SERVER
===================== */
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
