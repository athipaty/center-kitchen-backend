const express = require("express");
const router = express.Router();

const PhysicalCount = require("../models/PhysicalCount");
const Tag = require("../models/Tag");
const SystemStock = require("../models/SystemStock");
const Location = require("../models/Location");

router.get("/", (req, res) => {
  res.json({ message: "return from / routes" });
});

router.post("/count", async (req, res) => {
  try {
    const { tagNo, partNo, location, qtyPerBox, boxes, openBoxQty } = req.body;

    if (!tagNo || !partNo || !location) {
      return res
        .status(400)
        .json({ error: "tagNo, partNo, location are required" });
    }

    const qpb = Number(qtyPerBox);
    const bx = Number(boxes);
    const open =
      openBoxQty === undefined || openBoxQty === "" ? 0 : Number(openBoxQty);

    if ([qpb, bx, open].some((n) => Number.isNaN(n))) {
      return res
        .status(400)
        .json({ error: "qtyPerBox, boxes, openBoxQty must be numbers" });
    }

    if (qpb < 0 || bx < 0 || open < 0) {
      return res.status(400).json({ error: "Values cannot be negative" });
    }

    if (!Number.isInteger(bx)) {
      return res.status(400).json({ error: "Boxes must be an integer" });
    }

    const totalQty = qpb * bx + open;

    const doc = await PhysicalCount.create({
      tagNo: String(tagNo).trim(),
      partNo: String(partNo).trim(),
      location: String(location).trim(),
      qtyPerBox: qpb,
      boxes: bx,
      openBoxQty: open, // ✅ saved as 0 if not given
      totalQty,
    });

    res.json({ ok: true, record: doc });
  } catch (err) {
    console.error("COUNT SAVE ERROR:", err);
    res.status(500).json({ error: "Failed to save count" });
  }
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
          total: { $sum: "$totalQty" }, // ✅ use totalQty
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
      // group by part + location
      {
        $group: {
          _id: {
            partNo: "$partNo",
            location: "$location",
          },
          totalQty: { $sum: "$totalQty" },

          // preserve box info (assumes consistent packing per location)
          qtyPerBox: { $first: "$qtyPerBox" },
          boxes: { $sum: "$boxes" },
          openBoxQty: { $sum: "$openBoxQty" },
        },
      },

      // group by part
      {
        $group: {
          _id: "$_id.partNo",
          totalActual: { $sum: "$totalQty" },
          locations: {
            $push: {
              location: "$_id.location",
              totalQty: "$totalQty",
              qtyPerBox: "$qtyPerBox",
              boxes: "$boxes",
              openBoxQty: "$openBoxQty",
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
