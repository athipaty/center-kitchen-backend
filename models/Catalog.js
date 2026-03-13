const mongoose = require("mongoose");

const CatalogSchema = new mongoose.Schema(
  {
    // Identity
    partNo:    { type: String, required: true, unique: true },
    name:      String,
    customer:  String,
    supplier:  String,

    // Classification
    category: {
      type: String,
      enum: ["Fastener", "Washer", "Pin", "Ring", "Rivet", "Insert", "Collar", "Other", ""],
    },
    type: {
      type: String,
      enum: ["Bolt", "Nut", "Screw", "Stud", "Washer", "Pin", "Ring", "Rivet", "Insert", "Collar", ""],
    },

    volumePerMonth: Number,
    qtyPerBox:      Number,   // ← new
    location:       String,   // ← new (e.g. "A1-02", "Shelf B3")

    // Specifications
    spec: {
      material:         String,
      heatTreatment:    String,
      surfaceTreatment: String,

      headType:   String,
      driveType:  String,
      threadSize: String,

      length:        Number,
      outerDiameter: String,
      innerDiameter: String,
      thickness:     Number,

      standard: String,
      grade:    String,
      note:     String,
    },

    photo: {
      main:      String,
      thumbnail: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Catalog", CatalogSchema);