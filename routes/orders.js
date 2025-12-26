const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const Outlet = require("../models/Outlet");


/* ================================
   GET orders
   - Outlet: ?outletId=xxx
   - Center Kitchen: no outletId → ALL
================================ */
router.get("/", async (req, res) => {
  try {
    const { outletId, status } = req.query;

    const filter = {};

    // Outlet-scoped (used by OrderPage)
    if (outletId) {
      filter.outletId = outletId;
    }

    // Optional status filter
    if (status) {
      filter.status = status;
    }

    const orders = await Order.find(filter).sort({
      deliveryDate: 1,
      createdAt: -1,
    });

    res.json(orders);
  } catch (err) {
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
      return res.status(400).json({
        message: "outletId is required",
      });
    }

    // ✅ Resolve outlet name from DB (SOURCE OF TRUTH)
    const outlet = await Outlet.findById(outletId);
    if (!outlet) {
      return res.status(400).json({
        message: "Invalid outletId",
      });
    }

    const order = new Order({
      outletId,
      outletName: outlet.name, // ✅ ALWAYS SET
      sauce,
      quantity,
      deliveryDate,
      status,
    });

    const newOrder = await order.save();
    res.status(201).json(newOrder);
  } catch (err) {
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
      return res.status(400).json({
        message: "outletId is required for update",
      });
    }

    const order = await Order.findOne({
      _id: req.params.id,
      outletId,
    });

    if (!order) {
      return res.status(403).json({
        message: "Unauthorized or order not found",
      });
    }

    Object.assign(order, req.body);
    const updated = await order.save();

    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ================================
   DELETE order
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
   MARK order as delivered
================================ */
router.patch("/:id/deliver", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    order.status = "delivered";
    await order.save();

    res.json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



module.exports = router;
