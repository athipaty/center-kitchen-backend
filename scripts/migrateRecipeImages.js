// Run from backend folder: node scripts/migrateRecipeImages.js
require("dotenv").config();
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const path = require("path");
const Recipe = require("../models/Recipe");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Absolute path to the recipe app's public folder
const PUBLIC_DIR = path.resolve(
  __dirname,
  "../../../recipe/my-react-app/client/public"
);

const RECIPES_JS = path.resolve(
  __dirname,
  "../../../recipe/my-react-app/client/src/recipes.js"
);

function loadStaticRecipes() {
  const content = fs.readFileSync(RECIPES_JS, "utf8");
  // Convert ES module export to CommonJS so we can require it
  const cjs = content.replace(/export\s+default\s+\w+\s*;?\s*$/, "module.exports = recipes;");
  const tmp = path.join(__dirname, "_tmp_recipes.js");
  fs.writeFileSync(tmp, cjs);
  try {
    return require(tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
}

async function uploadLocal(imgPath) {
  // Already a remote URL — skip
  if (!imgPath || imgPath.startsWith("http")) return imgPath;

  // Normalise double-slash paths like /images//rice-ball.jpg
  const localPath = path.join(PUBLIC_DIR, imgPath);

  if (!fs.existsSync(localPath)) {
    console.warn(`    ⚠️  Not found: ${localPath}`);
    return imgPath;
  }

  const result = await cloudinary.uploader.upload(localPath, {
    folder: "sgo-recipes",
    use_filename: true,
    unique_filename: false,
    overwrite: false, // skip if already uploaded with same public_id
  });

  return result.secure_url;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI, {
    family: 4,
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 600000,
    connectTimeoutMS: 30000,
  });
  console.log("✅ Connected to MongoDB\n");

  if (!fs.existsSync(PUBLIC_DIR)) {
    console.error(`❌ Public dir not found: ${PUBLIC_DIR}`);
    process.exit(1);
  }

  let count = await Recipe.countDocuments();
  if (count === 0) {
    console.log("No recipes in DB — seeding from static data...");
    const staticRecipes = loadStaticRecipes();
    await Recipe.insertMany(staticRecipes);
    console.log(`✅ Seeded ${staticRecipes.length} recipes\n`);
  }

  const recipes = await Recipe.find();
  console.log(`Found ${recipes.length} recipes\n`);

  let totalUploaded = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const recipe of recipes) {
    console.log(`📋 ${recipe.name}`);
    let changed = false;

    // Recipe main image
    try {
      const newUrl = await uploadLocal(recipe.image);
      if (newUrl !== recipe.image) {
        recipe.image = newUrl;
        changed = true;
        totalUploaded++;
        console.log(`    ✅ main image`);
      } else {
        totalSkipped++;
      }
    } catch (err) {
      console.error(`    ❌ main image: ${err?.message || String(err)}`);
      totalErrors++;
    }

    // Ingredient images
    for (const ing of recipe.ingredients) {
      if (!ing.image) continue;
      try {
        const newUrl = await uploadLocal(ing.image);
        if (newUrl !== ing.image) {
          ing.image = newUrl;
          changed = true;
          totalUploaded++;
          console.log(`    ✅ ${ing.item}`);
        } else {
          totalSkipped++;
        }
      } catch (err) {
        console.error(`    ❌ ${ing.item}: ${err?.message || String(err)}`);
        totalErrors++;
      }
    }

    if (changed) {
      recipe.markModified("ingredients");
      await recipe.save();
      console.log(`    💾 saved\n`);
    } else {
      console.log(`    ⏭️  all already on Cloudinary\n`);
    }
  }

  console.log("─────────────────────────────────");
  console.log(`✅ Uploaded : ${totalUploaded}`);
  console.log(`⏭️  Skipped  : ${totalSkipped}`);
  console.log(`❌ Errors   : ${totalErrors}`);
  console.log("─────────────────────────────────");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
