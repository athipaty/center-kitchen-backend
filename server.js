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
      "https://athipaty-center-kitchen-frontend.vercel.app",
      "https://supplier-nine.vercel.app",
      "https://inventory-ten-omega.vercel.app",
      "https://milk-tracker-rho-topaz.vercel.app",

    ],
    credentials: true,
  })
);
app.use(express.json());

/* =====================
   ROUTES (UNCHANGED + NEW PUSH ROUTE)
===================== */
app.use("/orders", require("./routes/orders"));
app.use("/outlets", require("./routes/outlets"));
app.use("/sauces", require("./routes/sauces"));
app.use("/products", require("./routes/products"));
app.use("/inventory", require("./routes/inventory"));
app.use("/chat", require("./routes/chat"));
app.use("/push", require("./routes/push")); // ✅ NEW
app.use("/suppliers", require("./routes/suppliers"));
app.use("/products", require("./routes/products"));


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
  path: "/socket.io",
  cors: {
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://athipaty-center-kitchen-frontend.vercel.app",
      "https://supplier-nine.vercel.app",
    ],
    credentials: true,
  },
  transports: ["websocket"],
});

app.set("io", io);

/* =====================
   PRESENCE (for receipts + push logic)
   roomPresence = Map<roomId, Map<userId, socketId>>
===================== */
const roomPresence = new Map();

function setPresence(roomId, userId, socketId) {
  if (!roomPresence.has(roomId)) roomPresence.set(roomId, new Map());
  roomPresence.get(roomId).set(userId, socketId);
}
function removePresence(roomId, userId) {
  const roomMap = roomPresence.get(roomId);
  if (!roomMap) return;
  roomMap.delete(userId);
  if (roomMap.size === 0) roomPresence.delete(roomId);
}
function isUserOnlineInRoom(roomId, userId) {
  return !!roomPresence.get(roomId)?.get(userId);
}

/* =====================
   SOCKET EVENTS
===================== */
io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);

  socket.on("joinRoom", ({ roomId, userId }) => {
    if (!roomId || !userId) return;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userId = userId;

    setPresence(roomId, userId, socket.id);

    console.log(`📥 ${socket.id} joined room ${roomId} as ${userId}`);

    // let others know this user is online (optional)
    io.to(roomId).emit("presence", {
      roomId,
      userId,
      online: true,
    });
  });

  socket.on("leaveRoom", ({ roomId, userId }) => {
    if (!roomId || !userId) return;
    socket.leave(roomId);
    removePresence(roomId, userId);

    io.to(roomId).emit("presence", { roomId, userId, online: false });
  });

  // ✅ Typing indicator
  socket.on("typing", ({ roomId, userId, isTyping }) => {
    if (!roomId || !userId) return;
    socket.to(roomId).emit("typing", { roomId, userId, isTyping: !!isTyping });
  });

  // ✅ Read receipts (client sends messageIds that are now read)
  socket.on("markRead", async ({ roomId, userId, messageIds }) => {
    try {
      if (!roomId || !userId || !Array.isArray(messageIds) || !messageIds.length)
        return;

      const Message = require("./models/Message");
      const now = new Date();

      // Store read time per userId
      await Message.updateMany(
        { _id: { $in: messageIds }, roomId },
        { $set: { [`readBy.${userId}`]: now } }
      );

      // broadcast to room
      io.to(roomId).emit("messageRead", {
        roomId,
        userId,
        messageIds,
        readAt: now,
      });
    } catch (err) {
      console.error("markRead error:", err);
    }
  });

  socket.on("disconnect", () => {
    const { roomId, userId } = socket.data || {};
    if (roomId && userId) {
      removePresence(roomId, userId);
      io.to(roomId).emit("presence", { roomId, userId, online: false });
    }
    console.log("❌ Socket disconnected:", socket.id);
  });
});

// ✅ expose helper for routes (push logic may check online presence)
app.set("isUserOnlineInRoom", isUserOnlineInRoom);

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
