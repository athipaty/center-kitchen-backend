// migrate-stock-unit.js
// Run with: node migrate-stock-unit.js
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
    const topStock = product.stock ?? 0;
    const topUnit = product.unit ?? "";

    let suppliers = Array.isArray(product.suppliers) ? [...product.suppliers] : [];

    if (suppliers.length === 0) {
      // No suppliers — create one named "A"
      suppliers = [{
        name: "A",
        price: 0,
        stock: topStock,
        unit: topUnit,
      }];
    } else {
      // Move stock + unit into first supplier
      suppliers[0] = {
        ...suppliers[0],
        stock: suppliers[0].stock ?? topStock,
        unit: suppliers[0].unit ?? topUnit,
      };

      // Fill remaining suppliers with unit if missing
      for (let i = 1; i < suppliers.length; i++) {
        suppliers[i] = {
          ...suppliers[i],
          stock: suppliers[i].stock ?? 0,
          unit: suppliers[i].unit ?? topUnit,
        };
      }
    }

    await collection.updateOne(
      { _id: product._id },
      {
        $set: { suppliers },
        $unset: { stock: "", unit: "" },
      }
    );

    console.log(`✅ Updated: ${product.name}`);
    updated++;
  }

  console.log(`\nDone! Updated ${updated} / ${products.length} products`);
  mongoose.disconnect();
});