const express = require("express");
const Supplier = require("../models/Supplier");
const router = express.Router();

router.get("/", async (req, res) => {
  const data = await Supplier.find().sort({ name: 1 });
  res.json(data);
});

router.post("/", async (req, res) => {
  const supplier = await Supplier.create(req.body);
  res.json(supplier);
});

router.put("/:id", async (req, res) => {
  const updated = await Supplier.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  res.json(updated);
});

router.delete("/:id", async (req, res) => {
  await Supplier.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

module.exports = router;
