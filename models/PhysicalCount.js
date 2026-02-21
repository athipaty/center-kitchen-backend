const mongoose = require("mongoose");

const PhysicalCountSchema = new mongoose.Schema(
  {
    tagNo: { type: String, required: true, trim: true },
    partNo: { type: String, required: true, trim: true },
    location: { type: String, required: true, trim: true },

    qtyPerBox: { type: Number, required: true, min: 0 },
    boxes: { type: Number, required: true, min: 0 }, // allow 0 (if only open box)
    openBoxQty: { type: Number, required: true, min: 0 },

    subtotalQty: { type: Number, required: true, min: 0 },
    totalQty: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

// Optional: index if you query/group often
PhysicalCountSchema.index({ partNo: 1, location: 1 });
PhysicalCountSchema.index({ tagNo: 1 });

module.exports = mongoose.model("PhysicalCount", PhysicalCountSchema);