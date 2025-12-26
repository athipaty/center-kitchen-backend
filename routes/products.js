const express = require('express');
const router = express.Router();
const Product = require('../models/Product');

// Get all products (filterable by outlet)
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.outletName) {
      filter.outletName = req.query.outletName;
    }
    const products = await Product.find(filter).sort({ name: 1 });
    res.json(products);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get product by barcode
router.get('/:barcode', async (req, res) => {
  try {
    const product = await Product.findOne({ barcode: req.params.barcode });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Create new product
router.post('/', async (req, res) => {
  try {
    const { barcode, name, quantity, outletName } = req.body;

    const existing = await Product.findOne({ barcode, outletName });
    if (existing) {
      return res.status(400).json({ message: 'Product already exists' });
    }

    const product = new Product({ barcode, name, quantity, outletName });
    await product.save();
    res.status(201).json(product);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update product
router.put('/:barcode', async (req, res) => {
  try {
    const { quantity, outletName, name } = req.body;
    const product = await Product.findOne({ barcode: req.params.barcode, outletName });

    if (!product) return res.status(404).json({ message: 'Product not found' });

    product.quantity = quantity;
    product.name = name || product.name;
    await product.save();

    res.json(product);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete product
router.delete('/:barcode', async (req, res) => {
  try {
    const { outletName } = req.query;
    const deleted = await Product.findOneAndDelete({
      barcode: req.params.barcode,
      outletName,
    });

    if (!deleted) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting product', error: err });
  }
});

module.exports = router;
