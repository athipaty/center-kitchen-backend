const express = require('express');
const router = express.Router();
const Order = require('../models/Order');


// =======================
// GET all orders
// =======================
router.get('/', async (req, res) => {
  try {
    const orders = await Order.find();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// =======================
// CREATE new order
// =======================
router.post('/', async (req, res) => {
  try {
    const order = new Order({
      outletName: req.body.outletName,
      sauce: req.body.sauce,
      quantity: req.body.quantity,
      deliveryDate: req.body.deliveryDate,
      status: req.body.status || 'pending', // ✅ default pending
    });

    const newOrder = await order.save();
    res.status(201).json(newOrder);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});


// =======================
// UPDATE order (edit OR mark delivered)
// =======================
router.put('/:id', async (req, res) => {
  try {
    const updatedOrder = await Order.findByIdAndUpdate(
      req.params.id,
      {
        outletName: req.body.outletName,
        sauce: req.body.sauce,
        quantity: req.body.quantity,
        deliveryDate: req.body.deliveryDate,
        status: req.body.status, // ✅ IMPORTANT
      },
      { new: true }
    );

    if (!updatedOrder) {
      return res.status(404).json({ message: 'Order not found' });
    }

    res.json(updatedOrder);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// =======================
// DELETE order
// =======================
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Order.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: 'Order not found' });
    }
    res.json({ message: 'Order deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
