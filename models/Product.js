const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Product name is required"],
      trim: true,
    },
    suppliers: [
      {
        name: { type: String, trim: true, default: "A" },
        price: { type: Number, default: 0 },
        stock: { type: Number, default: 0 },
        unit: { type: String, trim: true, default: "" },
      },
    ],
    locations: [{ type: String, trim: true }],
    imageUrl: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Product", productSchema);