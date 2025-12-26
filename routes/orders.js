const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const Outlet = require("../models/Outlet");

/* ================================
   GET orders
   - Outlet: ?outletId=xxx
   - Center Kitchen: no outletId OR outletId=ALL
================================ */
router.get("/", async (req, res) => {
  try {
    const { outletId, status } = req.query;
    const filter = {};

    // Outlet-scoped only when valid outletId is provided
    if (outletId && outletId !== "ALL") {
      filter.outletId = outletId;
    }

    if (status) {
      filter.status = status;
    }

    const orders = await Order.find(filter)
      .sort({ deliveryDate: 1, createdAt: -1 })
      .lean();

    // 🛡️ SAFETY: ensure outletName always exists
    orders.forEach((o) => {
      if (!o.outletName) {
        o.outletName = "Unknown Outlet";
      }
    });

    res.json(orders);
  } catch (err) {
    console.error("GET /orders error:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ================================
   CREATE order
================================ */
router.post("/", async (req, res) => {
  try {
    const {
      outletId,
      sauce,
      quantity,
      deliveryDate,
      status = "pending",
    } = req.body;

    if (!outletId) {
      return res.status(400).json({ message: "outletId is required" });
    }

    // 🔒 Resolve outlet name from DB (source of truth)
    const outlet = await Outlet.findById(outletId);
    if (!outlet) {
      return res.status(400).json({ message: "Invalid outletId" });
    }

    const order = new Order({
      outletId,
      outletName: outlet.name, // ✅ ALWAYS SET HERE
      sauce,
      quantity,
      deliveryDate,
      status,
    });

    const newOrder = await order.save();
    res.status(201).json(newOrder);
  } catch (err) {
    console.error("POST /orders error:", err);
    res.status(400).json({ message: err.message });
  }
});

/* ================================
   UPDATE order (outlet-protected)
================================ */
router.put("/:id", async (req, res) => {
  try {
    const { outletId } = req.body;

    if (!outletId) {
      return res
        .status(400)
        .json({ message: "outletId is required for update" });
    }

    const order = await Order.findOne({
      _id: req.params.id,
      outletId,
    });

    if (!order) {
      return res
        .status(403)
        .json({ message: "Unauthorized or order not found" });
    }

    // 🔒 Only allow safe fields to change
    const { quantity, deliveryDate, sauce, status } = req.body;

    if (quantity !== undefined) order.quantity = quantity;
    if (deliveryDate) order.deliveryDate = deliveryDate;
    if (sauce) order.sauce = sauce;
    if (status) order.status = status;

    const updatedOrder = await order.save(); // ✅ FIXED

    res.json(updatedOrder); // ✅ FIXED
  } catch (err) {
    console.error("PUT /orders error:", err);
    res.status(500).json({ message: err.message });
  }
});

/* ================================
   DELETE order (not used by kitchen)
================================ */
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await Order.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.json({ message: "Order deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ================================
   MARK delivered
================================ */
router.patch("/:id/deliver", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    order.status = "delivered";
    await order.save();

    res.json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ================================
   UNDO delivered
================================ */
router.patch("/:id/undo-deliver", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    order.status = "pending";
    await order.save();

    res.json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
