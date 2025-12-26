// routes/outlets.js
const express = require('express');
const router = express.Router();
const Outlet = require('../models/Outlet');
const Order = require("../models/Order");
const Sauce = require("../models/Sauce");


// ✅ Get all outlets
router.get('/', async (req, res) => {
  try {
    const outlets = await Outlet.find();
    res.json(outlets);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ✅ Add a new outlet
router.post('/', async (req, res) => {
  const outlet = new Outlet(req.body);
  try {
    const newOutlet = await outlet.save();
    res.status(201).json(newOutlet);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* ================================
   UPDATE outlet
================================ */
router.put("/:id", async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Outlet name is required" });
    }

    const outlet = await Outlet.findById(req.params.id);
    if (!outlet) {
      return res.status(404).json({ message: "Outlet not found" });
    }

    outlet.name = name.trim();
    await outlet.save();

    res.json(outlet);
  } catch (err) {
    console.error("PUT /outlets error:", err);
    res.status(500).json({ message: err.message });
  }
});


/* ================================
   DELETE outlet (SAFE)
================================ */
router.delete("/:id", async (req, res) => {
  try {
    const outlet = await Outlet.findById(req.params.id);
    if (!outlet) {
      return res.status(404).json({ message: "Outlet not found" });
    }

    // 🔒 Check orders
    const orderCount = await Order.countDocuments({
      outletId: outlet._id,
    });

    if (orderCount > 0) {
      return res.status(409).json({
        message: "Cannot delete outlet. Orders exist for this outlet.",
      });
    }

    // 🔒 Check sauces
    const sauceCount = await Sauce.countDocuments({
      outletId: outlet._id,
    });

    if (sauceCount > 0) {
      return res.status(409).json({
        message: "Cannot delete outlet. Sauces exist for this outlet.",
      });
    }

    await Outlet.findByIdAndDelete(req.params.id);
    res.json({ message: "Outlet deleted successfully" });
  } catch (err) {
    console.error("DELETE /outlets error:", err);
    res.status(500).json({ message: err.message });
  }
});


module.exports = router;
