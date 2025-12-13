// routes/orders.js

const express = require('express');
const router = express.Router();
const Order = require('../models/Order');

// ✅ Get all orders
router.get('/', async (req, res) => {
  try {
    const orders = await Order.find();
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ✅ Create a new order
router.post('/', async (req, res) => {
  const order = new Order({
    outletName: req.body.outletName,
    sauce: req.body.sauce,
    quantity: req.body.quantity,
    deliveryDate: req.body.deliveryDate
  });

  try {
    const newOrder = await order.save();
    res.status(201).json(newOrder);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// ✅ Update an order by ID
router.put('/:id', async (req, res) => {
  try {
    const updatedOrder = await Order.findByIdAndUpdate(
      req.params.id,
      {
        outletName: req.body.outletName,
        sauce: req.body.sauce,
        quantity: req.body.quantity,
        deliveryDate: req.body.deliveryDate
      },
      { new: true } // return the updated document
    );

    if (!updatedOrder) {
      return res.status(404).json({ message: 'Order not found' });
    }

    res.json(updatedOrder);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// ✅ Delete an order by ID
router.delete('/:id', async (req, res) => {
  try {
    const deletedOrder = await Order.findByIdAndDelete(req.params.id);

    if (!deletedOrder) {
      return res.status(404).json({ message: 'Order not found' });
    }

    res.json({ message: 'Order deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
