const PreviousDiff = require("../models/PreviousDiff");
const SystemStock = require("../models/SystemStock");
const PhysicalCount = require("../models/PhysicalCount");

/* =====================
   VARIANCE (WITH LOCATION)
===================== */
router.get("/variance", async (req, res) => {
  try {
    const productionSet = await getProductionSet();

    // ✅ fetch previous diff map
    const prevDiffs = await PreviousDiff.find({});
    const prevDiffMap = new Map();
    prevDiffs.forEach((p) => {
      prevDiffMap.set(p.partNo, { price: p.price, diffN1: p.diffN1, diffN2: p.diffN2 });
    });

    // ---------- SYSTEM ----------
    const systemAgg = await SystemStock.aggregate([
      {
        $group: {
          _id: "$partNo",
          systemQty: { $sum: { $toDouble: "$systemQty" } },
        },
      },
    ]);

    const systemMap = new Map();
    systemAgg.forEach((s) => {
      if (!productionSet.has(s._id)) systemMap.set(s._id, s.systemQty);
    });

    // ---------- ACTUAL + LOCATION ----------
    const actualAgg = await PhysicalCount.aggregate([
      {
        $group: {
          _id: { partNo: "$partNo", location: "$location" },
          totalQty: { $sum: "$totalQty" },
          qtyPerBox: { $first: "$qtyPerBox" },
          boxes: { $sum: "$boxes" },
          openBoxQty: { $sum: "$openBoxQty" },
        },
      },
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
      if (productionSet.has(a._id)) return; // ✅ exclude production

      const systemQty = systemMap.get(a._id);
      if (systemQty === undefined) return; // ✅ not in system → Unrecognized
      if (Number(systemQty) === 0) return; // ✅ system qty 0 → exclude

      if (a.totalActual !== systemQty) {
        const prev = prevDiffMap.get(a._id);
        variances.push({
          partNo: a._id,
          actual: a.totalActual,
          system: systemQty,
          locations: a.locations,
          price: prev?.price ?? null,
          diffN1: prev?.diffN1 ?? null,
          diffN2: prev?.diffN2 ?? null,
        });
      }
    });

    res.json(variances);
  } catch (err) {
    console.error("VARIANCE ERROR:", err);
    res.status(500).json({ error: "Failed to calculate variance" });
  }
});