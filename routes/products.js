const express = require('express');
const router = express.Router();
const Product = require('../models/Product');

/**
 * GET all products (optional outlet filter)
 * /products?outletName=SGO
 */
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

/**
 * GET product by barcode
 * /products/:barcode
 */
router.get('/:barcode', async (req, res) => {
  try {
    const product = await Product.findOne({
      barcode: req.params.barcode,
    });

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json(product);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST new product
 * /products
 */
router.post('/', async (req, res) => {
  try {
    const { barcode, name, quantity, outletName } = req.body;

    const existing = await Product.findOne({ barcode, outletName });
    if (existing) {
      return res.status(400).json({ message: 'Product already exists' });
    }

    const product = new Product({
      barcode,
      name,
      quantity,
      outletName,
    });

    await product.save();
    res.status(201).json(product);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PUT update product quantity
 * /products/:barcode
 */
router.put('/:barcode', async (req, res) => {
  try {
    const { quantity, outletName } = req.body;

    const product = await Product.findOne({
      barcode: req.params.barcode,
      outletName,
    });

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    product.quantity = quantity;
    await product.save();

    res.json(product);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE a product by barcode
router.delete('/:barcode', async (req, res) => {
  try {
    const { barcode } = req.params;
    const deleted = await Product.findOneAndDelete({ barcode, outletName });
    if (!deleted) return res.status(404).json({ message: 'Product not found' });
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting product', error: err });
  }
});


module.exports = router;
