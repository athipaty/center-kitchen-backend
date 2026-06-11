const express = require('express');
const router = express.Router();
const FgProduct = require('../../models/accounting/FgProduct');

router.get('/', async (req, res) => {
  try {
    const { company = 'Express', month, year } = req.query;
    const filter = { company };
    if (month) filter.month = parseInt(month);
    if (year) filter.year = parseInt(year);
    const products = await FgProduct.find(filter).sort({ code: 1 });
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = { ...req.body, company: req.body.company || 'Express' };
    body.totalCost = (body.rmCost || 0) + (body.dmCost || 0) + (body.ohCost || 0) + (body.pkCost || 0);
    const qty = body.issued || body.received || 1;
    body.unitCost = qty > 0 ? body.totalCost / qty : 0;
    const product = new FgProduct(body);
    await product.save();
    res.status(201).json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const body = req.body;
    body.totalCost = (body.rmCost || 0) + (body.dmCost || 0) + (body.ohCost || 0) + (body.pkCost || 0);
    const qty = body.issued || body.received || 1;
    body.unitCost = qty > 0 ? body.totalCost / qty : 0;
    const product = await FgProduct.findByIdAndUpdate(req.params.id, body, { new: true });
    res.json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await FgProduct.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
