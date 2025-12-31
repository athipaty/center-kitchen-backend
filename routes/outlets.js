const express = require("express");
const router = express.Router();
const Outlet = require("../models/Outlet");
const Order = require("../models/Order");
const Sauce = require("../models/Sauce");

// GET all outlets
router.get("/", async (req, res) => {
  const outlets = await Outlet.find().sort({ name: 1 });
  res.json(outlets);
});

// GET outlet by ID
router.get("/:id", async (req, res) => {
  try {
    const outlet = await Outlet.findById(req.params.id);

    if (!outlet) {
      return res.status(404).json({ message: "Outlet not found" });
    }

    res.json(outlet);
  } catch (error) {
    res.status(400).json({ message: "Invalid outlet ID" });
  }
});


// CREATE outlet
router.post("/", async (req, res) => {
  if (!req.body.name?.trim()) {
    return res.status(400).json({ message: "Outlet name required" });
  }

  const outlet = new Outlet({ name: req.body.name });
  await outlet.save();
  res.status(201).json(outlet);
});

// UPDATE outlet name
router.put("/:id", async (req, res) => {
  const outlet = await Outlet.findById(req.params.id);
  if (!outlet) return res.status(404).json({ message: "Outlet not found" });

  outlet.name = req.body.name || outlet.name;
  await outlet.save();
  res.json(outlet);
});

// 🔒 SAFE DELETE outlet
router.delete("/:id", async (req, res) => {
  const outletId = req.params.id;

  const hasOrders = await Order.exists({ outletId });
  if (hasOrders) {
    return res.status(409).json({
      message: "Cannot delete outlet: orders exist",
    });
  }

  const hasSauces = await Sauce.exists({ outletId });
  if (hasSauces) {
    return res.status(409).json({
      message: "Cannot delete outlet: sauces exist",
    });
  }

  await Outlet.findByIdAndDelete(outletId);
  res.json({ message: "Outlet deleted" });
});

module.exports = router;
