// server.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://athipaty-center-kitchen-frontend.vercel.app",
    ],
    credentials: true,
  })
);
app.use(express.json());

app.use("/orders", require("./routes/orders"));
app.use("/outlets", require("./routes/outlets"));
app.use("/sauces", require("./routes/sauces"));
app.use("/products", require("./routes/products"));
app.use("/inventory", require("./routes/inventory"));
app.use("/chat", require("./routes/chat"));

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

const server = http.createServer(app);

// ✅ FIX: explicit path
const io = new Server(server, {
  path: "/socket.io",
  cors: {
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://athipaty-center-kitchen-frontend.vercel.app",
    ],
    credentials: true,
  },
  transports: ["websocket"],
});

app.set("io", io);

io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);

  socket.on("joinRoom", ({ roomId }) => {
    socket.join(roomId);
    console.log(`📥 ${socket.id} joined room ${roomId}`);
  });

  socket.on("leaveRoom", ({ roomId }) => {
    socket.leave(roomId);
  });

  socket.on("disconnect", () => {
    console.log("❌ Socket disconnected:", socket.id);
  });
});

app.get("/", (req, res) => {
  res.send("Center Kitchen API running 🚀");
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
