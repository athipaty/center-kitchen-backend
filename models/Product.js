const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema(
  {
    name: {type: String, required: true},
    price: {type: Number},
    stock: {type: Number},
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
    }
  },
  { timestamps: true}
)

module.exports = mongoose.model("Product", ProductSchema);