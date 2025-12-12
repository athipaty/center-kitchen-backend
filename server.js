const express = require('express');
const mongoose = require('mongoose');

const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const orderRoutes = require('./routes/orders');
app.use('/orders', orderRoutes);

// Sample route
app.get('/', (req, res) => {
  res.send('Backend is working!');
});

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(5000, () => {
      console.log('Server running on http://localhost:5000');
    });
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
  });
