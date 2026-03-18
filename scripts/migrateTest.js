// migrate.js
// Run with: node migrate.js
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

    // Fix suppliers: was a single ObjectId, now should be array of strings
    if (!Array.isArray(product.suppliers)) {
      changes.suppliers = [];
    }

    // Fix price: was missing, default to 0
    if (product.price === undefined || product.price === null) {
      changes.price = 0;
    }

    // Fix imageUrl: was missing, default to ""
    if (product.imageUrl === undefined) {
      changes.imageUrl = "";
    }

    // Remove old supplier field (single ObjectId)
    const unsetFields = {};
    if (product.supplier !== undefined) {
      unsetFields.supplier = "";
    }

    if (Object.keys(changes).length > 0 || Object.keys(unsetFields).length > 0) {
      const update = {};
      if (Object.keys(changes).length > 0) update.$set = changes;
      if (Object.keys(unsetFields).length > 0) update.$unset = unsetFields;

      await collection.updateOne({ _id: product._id }, update);
      console.log(`✅ Updated: ${product.name}`);
      updated++;
    }
  }

  console.log(`\nDone! Updated ${updated} / ${products.length} products`);
  mongoose.disconnect();
});