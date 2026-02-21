const mongoose = require("mongoose");

const PhysicalCountSchema = new mongoose.Schema(
  {
    tagNo: { type: String, required: true, trim: true },
    partNo: { type: String, required: true, trim: true },
    location: { type: String, required: true, trim: true },

    qtyPerBox: { type: Number, required: true, min: 0 },
    boxes: { type: Number, required: true, min: 0 },
    openBoxQty: { type: Number, default: 0, min: 0 }, // ✅ default 0

    totalQty: { type: Number, required: true, min: 0 }, // ✅ only total
  },
  { timestamps: true }
);

PhysicalCountSchema.index({ partNo: 1, location: 1 });
PhysicalCountSchema.index({ tagNo: 1 });

module.exports = mongoose.model("PhysicalCount", PhysicalCountSchema);