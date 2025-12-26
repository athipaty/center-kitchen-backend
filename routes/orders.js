const express = require("express");
const router = express.Router();
const Order = require("../models/Order");

/* ================================
   GET orders (OUTLET-SCOPED)
   ================================ */
router.get("/", async (req, res) => {
  try {
    const { outletId, outletName, status } = req.query;

    if (!outletId && !outletName) {
      return res.status(400).json({
        message: "outletId or outletName is required",
      });
    }

    const filter = {};

    if (outletId) {
      filter.outletId = outletId;
    } else {
      filter.outletName = outletName; // fallback
    }

    if (status) {
      filter.status = status;
    }

    const orders = await Order.find(filter)
      .sort({ deliveryDate: 1, createdAt: -1 });

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
      outletName,
      sauce,
      quantity,
      deliveryDate,
      status = "pending",
    } = req.body;

    if (!outletId && !outletName) {
      return res.status(400).json({
        message: "Outlet is required",
      });
    }

    const order = new Order({
      outletId: outletId || undefined,
      outletName,
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
   UPDATE order (SAFE)
   ================================ */
router.put("/:id", async (req, res) => {
  try {
    const { outletId, outletName } = req.body;

    if (!outletId && !outletName) {
      return res.status(400).json({
        message: "Outlet verification required",
      });
    }

    const filter = { _id: req.params.id };

    if (outletId) {
      filter.outletId = outletId;
    } else {
      filter.outletName = outletName;
    }

    const order = await Order.findOne(filter);

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
   DELETE order (SAFE)
   ================================ */
// ✅ Delete an order by ID
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

module.exports = router;
