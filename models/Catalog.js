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

    // Specifications
    spec: {
      material:         String,   // SWCH12A, SCM435, SUS304
      heatTreatment:    String,   // QT (HRC44-53), Carburizing
      surfaceTreatment: String,   // Zinc Plating, Trivalent Chromate

      headType:   String,         // Hex, Button, Flat, Pan, Truss, Flange
      driveType:  String,         // Phillips, Torx, Allen, Slotted
      threadSize: String,         // M6 x 1.0, M4 x 0.7

      length:        Number,      // mm
      outerDiameter: String,      // Ø12, Ø8.2
      innerDiameter: String,      // Ø6, Ø3.1
      thickness:     Number,      // mm

      standard: String,           // ISO, DIN, JIS, ASTM
      grade:    String,           // 8.8, A2-70
      note:     String,           // any extra info
    },

    photo: {
      main:      String,
      thumbnail: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Catalog", CatalogSchema);