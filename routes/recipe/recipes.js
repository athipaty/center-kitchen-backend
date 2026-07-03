const express = require("express");
const multer = require("multer");
const Recipe = require("../../models/recipe/Recipe");
const { uploadToB2 } = require("../../utils/b2Utils");

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });

// GET all recipes
router.get("/", async (req, res) => {
  try {
    const recipes = await Recipe.find().sort({ name: 1 });
    res.json(recipes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST seed â€” only runs if collection is empty
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

// POST create new recipe
router.post("/", async (req, res) => {
  try {
    const recipe = await Recipe.create(req.body);
    res.status(201).json(recipe);
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

// POST upload image
router.post("/upload-image", (req, res) => {
  upload.single("image")(req, res, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    try {
      const url = await uploadToB2(req.file.buffer, `recipe-images/${Date.now()}-${req.file.originalname}`, req.file.mimetype);
      res.json({ url });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

module.exports = router;

