const mongoose = require("mongoose");

const ingredientSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    image: { type: String, default: "" },
    qty: { type: Number, default: 0 },
    unit: { type: String, default: "g" },
    price: { type: Number, default: 0 },
    supplier: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ModuHighIngredient", ingredientSchema);
