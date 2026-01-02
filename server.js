// server.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
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
      "https://athipaty-center-kitchen-frontend.vercel.app/", //
    ],
    credentials: true,
  })
);
app.use(express.json());

/* =====================
   ROUTES (UNCHANGED)
===================== */
app.use("/orders", require("./routes/orders"));
app.use("/outlets", require("./routes/outlets"));
app.use("/sauces", require("./routes/sauces"));
app.use("/products", require("./routes/products"));
app.use("/inventory", require("./routes/inventory"));
app.use("/chat", require("./routes/chat")); // ✅ chat routes

/* =====================
   DATABASE
===================== */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

/* =====================
   HTTP + SOCKET SERVER
===================== */
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://YOUR-FRONTEND-DOMAIN.vercel.app", // 🔴 replace
    ],
    credentials: true,
  },
  transports: ["websocket"],
});

/* 🔑 expose io to routes */
app.set("io", io);

/* =====================
   SOCKET EVENTS
===================== */
io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);

  socket.on("joinRoom", ({ roomId }) => {
    if (!roomId) return;
    socket.join(roomId);
    console.log(`📥 ${socket.id} joined room ${roomId}`);
  });

  socket.on("leaveRoom", ({ roomId }) => {
    if (!roomId) return;
    socket.leave(roomId);
    console.log(`📤 ${socket.id} left room ${roomId}`);
  });

  socket.on("disconnect", () => {
    console.log("❌ Socket disconnected:", socket.id);
  });
});

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

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
