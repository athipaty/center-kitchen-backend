const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Routes
const orderRoutes = require('./routes/orders');
app.use('/orders', orderRoutes);

const outletRoutes = require('./routes/outlets');
app.use('/outlets', outletRoutes);

const sauceRoutes = require('./routes/sauces');
app.use('/sauces', sauceRoutes);

const productRoutes = require('./routes/products');
app.use('/products', productRoutes);


// MongoDB connect
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');
    app.listen(5000, () => console.log('🚀 Server running on https://center-kitchen-backend.onrender.com/orders'));
  })
  .catch((err) => console.error('❌ MongoDB connection error:', err));
