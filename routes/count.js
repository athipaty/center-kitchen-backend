const express = require("express");
const router = express.Router();

const PhysicalCount = require("../models/PhysicalCount");
const Tag = require("../models/Tag");
const SystemStock = require("../models/SystemStock");
const Location = require("../models/Location");

router.get("/", (req, res) => {
  res.json({ message: "return from / routes" });
});

router.post("/", async (req, res) => {
  const { partNo, actualQty, location, tagNo } = req.body;

  const record = await PhysicalCount.create({
    partNo,
    actualQty,
    location,
    tagNo,
  });

  res.json(record);
});

/* =====================
   COUNT STATUS
===================== */
router.get("/status", async (req, res) => {
  try {
    const totalTags = await Tag.countDocuments();
    const countedTags = await PhysicalCount.distinct("tagNo");

    res.json({
      counted: countedTags.length,
      total: totalTags,
    });
  } catch (err) {
    console.error("COUNT STATUS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch count status" });
  }
});

/* =====================
   DASHBOARD STATUS
===================== */
router.get("/dashboard-status", async (req, res) => {
  try {
    // ---------- SYSTEM ----------
    const systemParts = await SystemStock.distinct("partNo");

    const systemTotalQtyAgg = await SystemStock.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: "$systemQty" } },
        },
      },
    ]);
    const systemTotalQty = systemTotalQtyAgg[0]?.total || 0;

    // ---------- ACTUAL ----------
    const countedParts = await PhysicalCount.distinct("partNo");
    const countedLocations = await PhysicalCount.distinct("location");

    const actualQtyAgg = await PhysicalCount.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: "$actualQty" } },
        },
      },
    ]);
    const actualTotalQty = actualQtyAgg[0]?.total || 0;

    // ---------- LOCATION ----------
    const totalLocations = await Location.countDocuments();

    res.json({
      qty: {
        actual: actualTotalQty,
        system: systemTotalQty,
      },
      partNo: {
        actual: countedParts.length,
        system: systemParts.length,
      },
      location: {
        actual: countedLocations.length,
        system: totalLocations,
      },
    });
  } catch (err) {
    console.error("DASHBOARD STATUS ERROR:", err);
    res.status(500).json({ error: "Failed to load dashboard status" });
  }
});

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
