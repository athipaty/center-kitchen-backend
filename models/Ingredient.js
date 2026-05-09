const mongoose = require("mongoose");

const ingredientSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    price: { type: Number, default: 0 },
    weight: {
      value: { type: Number, default: 0 },
      unit: { type: String, default: "g" },
    },
    image: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Ingredient", ingredientSchema);
