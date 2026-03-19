// migrate-suppliers.js
// Run with: node migrate-suppliers.js
require("dotenv").config();
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGO_URI).then(async () => {
  console.log("✅ Connected to MongoDB");

  const db = mongoose.connection.db;
  const collection = db.collection("products");
  const products = await collection.find({}).toArray();
  console.log(`Found ${products.length} products`);

  let updated = 0;

  for (const product of products) {
    const changes = {};

    // Convert suppliers from strings to { name, price } objects
    if (Array.isArray(product.suppliers)) {
      const converted = product.suppliers.map((s) => {
        if (typeof s === "string") return { name: s, price: 0 };
        if (s.name !== undefined) return s; // already correct shape
        return { name: String(s), price: 0 };
      });
      changes.suppliers = converted;
    } else {
      changes.suppliers = [];
    }

    // Move top-level price into first supplier if exists
    if (product.price !== undefined && changes.suppliers.length > 0) {
      changes.suppliers[0].price = product.price;
    }

    // Remove top-level price field
    const update = {
      $set: changes,
      $unset: { price: "" },
    };

    await collection.updateOne({ _id: product._id }, update);
    console.log(`✅ Updated: ${product.name}`);
    updated++;
  }

  console.log(`\nDone! Updated ${updated} / ${products.length} products`);
  mongoose.disconnect();
});