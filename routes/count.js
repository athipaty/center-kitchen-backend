const express = require("express");
const Tag = require("../models/Tag");
const PhysicalCount = require("../models/PhysicalCount");

const router = express.Router();

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
      { $group: { _id: null, total: { $sum: "$systemQty" } } },
    ]);
    const systemTotalQty = systemTotalQtyAgg[0]?.total || 0;

    // ---------- ACTUAL ----------
    const countedParts = await PhysicalCount.distinct("partNo");
    const countedLocations = await PhysicalCount.distinct("location");
    const actualQtyAgg = await PhysicalCount.aggregate([
      { $group: { _id: null, total: { $sum: "$actualQty" } } },
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

module.exports = router;
