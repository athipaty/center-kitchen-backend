const mongoose = require("mongoose");

const ingredientSchema = new mongoose.Schema({
  item: { type: String, required: true },
  quantity: { type: Number, default: 0 },
  unit: { type: String, default: "g" },
  image: { type: String, default: "" },
});

const recipeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    image: { type: String, default: "" },
    ingredients: [ingredientSchema],
    method: { type: String, default: "" },
    active: { type: Boolean, default: false },
    type: { type: String, enum: ["sale", "staff"], default: "sale" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Recipe", recipeSchema);
