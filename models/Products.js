const mongoose = require("mongoose");

const ProductsSchema = new mongoose.Schema(
  {
    partNo: {
      type: String,
      required: true,
      unique: true,
    },

    name: String,

    category: String,

    type: String,

    spec: {
      standard: String,
      diameter: String,
      lengthMm: Number,
      threadPitch: Number,
      grade: String,
      material: String,
      coating: String,
    },

    photo: {
      main: String,
      thumbnail: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Products", ProductsSchema);