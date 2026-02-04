const express = require("express");
const Product = require("../models/Product");
const router = express.Router();

// GET all
router.get("/", async (req, res) => {
  const data = await Product.find().populate("supplier").sort({ name: 1 });
  res.json(data);
});

// POST
router.post("/", async (req, res) => {
  const product = await Product.create(req.body);
  res.json(product);
});

// PUT
router.put("/:id", async (req, res) => {
  const updated = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(updated);
});

// DELETE
// DELETE /suppliers/:id
router.delete("/:id", async (req, res) => {
  const count = await Product.countDocuments({
    supplier: req.params.id,
  });

  if (count > 0) {
    return res.status(400).json({
      message: "Cannot delete supplier with existing products",
    });
  }

  await Supplier.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});


module.exports = router;
