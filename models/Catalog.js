const mongoose = require("mongoose");

const CatalogSchema = new mongoose.Schema(
  {
    partNo: {
      type: String,
      required: true,
      unique: true,
    },

    name: String,
    category: String,
    type: String,

    customer: String,   // ✅ add this
    supplier: String,   // ✅ add this
    volumePerMonth: Number,  // ✅ add


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
  { timestamps: true },
);

module.exports = mongoose.model("Catalog", CatalogSchema);