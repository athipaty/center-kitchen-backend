const express = require("express");
const SystemStock = require("../models/SystemStock");
const PhysicalCount = require("../models/PhysicalCount");

const router = express.Router();

/* =====================
   VARIANCE (WITH LOCATION)
===================== */
router.get("/variance", async (req, res) => {
  try {
    // ---------- SYSTEM ----------
    const systemAgg = await SystemStock.aggregate([
      {
        $group: {
          _id: "$partNo",
          systemQty: {
            $sum: { $toDouble: "$systemQty" },
          },
        },
      },
    ]);

    const systemMap = new Map();
    systemAgg.forEach((s) => {
      systemMap.set(s._id, s.systemQty);
    });

    // ---------- ACTUAL + LOCATION ----------
    const actualAgg = await PhysicalCount.aggregate([
      {
        $group: {
          _id: {
            partNo: "$partNo",
            location: "$location",
          },
          qty: {
            $sum: { $toDouble: "$actualQty" },
          },
        },
      },
      {
        $group: {
          _id: "$_id.partNo",
          totalActual: { $sum: "$qty" },
          locations: {
            $push: {
              location: "$_id.location",
              qty: "$qty",
            },
          },
        },
      },
    ]);

    // ---------- COMPARE ----------
    const variances = [];

    actualAgg.forEach((a) => {
      const systemQty = systemMap.get(a._id) || 0;

      if (a.totalActual !== systemQty) {
        variances.push({
          partNo: a._id,
          actual: a.totalActual,
          system: systemQty,
          locations: a.locations, // ✅ THIS IS THE FIX
        });
      }
    });

    res.json(variances);
  } catch (err) {
    console.error("VARIANCE ERROR:", err);
    res.status(500).json({ error: "Failed to calculate variance" });
  }
});

module.exports = router;
