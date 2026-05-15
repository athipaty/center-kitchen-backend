// server.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const { createServer } = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

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
      "https://amazon-theta-liard.vercel.app"
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

// --- Amazon Tracker ---
app.use('/api/tracker', require('./routes/tracker'));

// --- eBay ---
app.use('/api/ebay', require('./routes/ebay'));

/* =====================
   DATABASE
===================== */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB");
    require("./jobs/trackerScheduler").start(io);
  })
  .catch((err) => console.error("❌ MongoDB connection error:", err));

/* =====================
   HEALTH CHECK
===================== */
app.get("/", (req, res) => res.send("API is running 🚀"));

/* =====================
   START SERVER
===================== */
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
