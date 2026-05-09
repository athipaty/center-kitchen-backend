const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const Recipe = require("../models/Recipe");

const router = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: { folder: "sgo-recipes" },
});

const upload = multer({ storage });

// GET all recipes
router.get("/", async (req, res) => {
  try {
    const recipes = await Recipe.find().sort({ name: 1 });
    res.json(recipes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST seed — only runs if collection is empty
router.post("/seed", async (req, res) => {
  try {
    const count = await Recipe.countDocuments();
    if (count > 0) return res.json({ message: "Already seeded", count });
    const inserted = await Recipe.insertMany(req.body);
    res.json({ message: "Seeded", count: inserted.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update recipe
router.put("/:id", async (req, res) => {
  try {
    const recipe = await Recipe.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!recipe) return res.status(404).json({ error: "Recipe not found" });
    res.json(recipe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST upload image to Cloudinary
router.post("/upload-image", (req, res) => {
  upload.single("image")(req, res, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    res.json({ url: req.file.path });
  });
});

module.exports = router;
