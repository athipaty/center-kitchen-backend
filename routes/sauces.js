const express = require("express");
const router = express.Router();
const Sauce = require("../models/Sauce");
const Order = require("../models/Order");

// GET sauces (ALL or by outlet)
router.get("/", async (req, res) => {
  const { outletId } = req.query;

  const filter = outletId && outletId !== "ALL"
    ? { outletId }
    : {};

  const sauces = await Sauce.find(filter).populate("outletId");
  res.json(sauces);
});

// CREATE sauce
router.post("/", async (req, res) => {
  const { name, outletId, standardWeightKg } = req.body;

  if (!name || !outletId || !standardWeightKg) {
    return res.status(400).json({ message: "Missing fields" });
  }

  const sauce = new Sauce({ name, outletId, standardWeightKg });
  await sauce.save();
  res.status(201).json(sauce);
});

// UPDATE sauce
router.put("/:id", async (req, res) => {
  const sauce = await Sauce.findById(req.params.id);
  if (!sauce) return res.status(404).json({ message: "Sauce not found" });

  sauce.name = req.body.name ?? sauce.name;
  sauce.standardWeightKg =
    req.body.standardWeightKg ?? sauce.standardWeightKg;

  await sauce.save();
  res.json(sauce);
});

// 🔒 SAFE DELETE sauce
router.delete("/:id", async (req, res) => {
  const sauce = await Sauce.findById(req.params.id);
  if (!sauce) return res.status(404).json({ message: "Sauce not found" });

  const used = await Order.exists({ sauce: sauce.name });
  if (used) {
    return res.status(409).json({
      message: "Cannot delete sauce: used in orders",
    });
  }

  await sauce.deleteOne();
  res.json({ message: "Sauce deleted" });
});

module.exports = router;
