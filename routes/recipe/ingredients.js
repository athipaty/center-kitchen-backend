const express = require("express");
const Ingredient = require("../../models/recipe/Ingredient");
const router = express.Router();

// GET all saved ingredient overrides
router.get("/", async (req, res) => {
  try {
    const ingredients = await Ingredient.find().sort({ name: 1 });
    res.json(ingredients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST upsert by name (create or update) — partial payloads only touch the
// fields they send, so e.g. saving just an image never wipes a saved price.
router.post("/", async (req, res) => {
  try {
    const ingredient = await Ingredient.findOneAndUpdate(
      { name: req.body.name },
      { $set: req.body },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json(ingredient);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

