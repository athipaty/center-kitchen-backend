require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
});
const mongoose = require("mongoose");
const Catalog = require("../models/Catalog");

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected to MongoDB");

  // ── CONFIG: define which (category, type) pairs to migrate and how ──
  const migrations = [
    { fromCategory: "Fastener", fromType: "Bolt" },
    { fromCategory: "Fastener", fromType: "Nut" },
    { fromCategory: "Fastener", fromType: "Screw" },
    { fromCategory: "Fastener", fromType: "Stud" },
  ];

  for (const { fromCategory, fromType } of migrations) {
    const parts = await Catalog.find({
      category: fromCategory,
      type: fromType,
    });

    console.log(
      `\n── ${fromCategory} / ${fromType} → ${parts.length} parts ──`,
    );

    let updated = 0;
    let skipped = 0;

    for (const part of parts) {
      const headType = part.spec?.headType?.trim();

      // New type = "{headType} {fromType}" if headType exists, else just fromType
      const newType = headType ? `${headType} ${fromType}` : fromType;

      await Catalog.updateOne(
        { _id: part._id },
        {
          $set: {
            category: fromType, // e.g. "Bolt"
            type: newType, // e.g. "Hex Bolt", "Flange Bolt"
          },
        },
      );

      console.log(
        `  ✓ ${part.partNo} → category: ${fromType}, type: ${newType}`,
      );
      updated++;
    }

    console.log(`  → ${updated} updated, ${skipped} skipped`);
  }

  console.log("\n✅ Migration complete");
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
