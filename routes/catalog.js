const express = require("express");
const Catalog = require("../models/Catalog");
const router = express.Router();

// ===============================
// GET ALL
// ===============================
router.get("/", async (req, res) => {
  try {
    const products = await Catalog.find();
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===============================
// SEARCH
// ===============================
router.get("/search", async (req, res) => {
  try {
    const { diameter, length, material, type } = req.query;

    const filter = {};
    if (diameter) filter["spec.diameter"] = diameter;
    if (length) filter["spec.lengthMm"] = Number(length);
    if (material) filter["spec.material"] = material;
    if (type) filter.type = type;

    const products = await Catalog.find(filter); // ✅ was Products
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===============================
// GET ONE
// ===============================
router.get("/:id", async (req, res) => {
  try {
    const product = await Catalog.findById(req.params.id); // ✅ was Products
    if (!product) return res.status(404).json({ message: "Product not found" });
    res.json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===============================
// CREATE
// ===============================
router.post("/", async (req, res) => {
  try {
    const product = new Catalog(req.body); // ✅ was Products
    const savedProduct = await product.save();
    res.status(201).json(savedProduct);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// ===============================
// UPDATE
// ===============================
router.put("/:id", async (req, res) => {
  try {
    const updatedProduct = await Catalog.findByIdAndUpdate( // ✅ was Products
      req.params.id,
      req.body,
      { new: true }
    );
    if (!updatedProduct) return res.status(404).json({ message: "Product not found" });
    res.json(updatedProduct);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// ===============================
// DELETE
// ===============================
router.delete("/:id", async (req, res) => {
  try {
    const deletedProduct = await Catalog.findByIdAndDelete(req.params.id); // ✅ was Products
    if (!deletedProduct) return res.status(404).json({ message: "Product not found" });
    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;