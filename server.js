// server.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

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
    ],
    credentials: true,
  })
);
app.use(express.json());

/* =====================
   ROUTES
===================== */
app.use("/orders", require("./routes/orders"));
app.use("/outlets", require("./routes/outlets"));
app.use("/sauces", require("./routes/sauces"));
app.use("/products", require("./routes/products"));
app.use("/inventory", require("./routes/inventory"));
app.use("/suppliers", require("./routes/suppliers"));
app.use("/api/milk", require("./routes/milkRoutes"));
app.use("/upload", require("./routes/upload"));
app.use("/count", require("./routes/count"));
app.use("/variance", require("./routes/variance"));


/* =====================
   DATABASE
===================== */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

/* =====================
   HEALTH CHECK
===================== */
app.get("/", (req, res) => {
  res.send("Center Kitchen API running 🚀");
});

/* =====================
   START SERVER
===================== */
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
