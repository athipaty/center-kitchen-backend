const express = require("express");
const SystemStock = require("../models/SystemStock");
const PhysicalCount = require("../models/PhysicalCount");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    // Sum actual qty by partNo
    const actuals = await PhysicalCount.aggregate([
      {
        $group: {
          _id: "$partNo",
          actualQty: { $sum: "$actualQty" },
        },
      },
    ]);

    // Get system stock
    const systemStocks = await SystemStock.find();

    const systemMap = {};
    systemStocks.forEach((s) => {
      systemMap[s.partNo] = s.systemQty;
    });

    const result = actuals.map((a) => {
      const systemQty = systemMap[a._id] || 0;
      return {
        partNo: a._id,
        systemQty,
        actualQty: a.actualQty,
        difference: a.actualQty - systemQty,
      };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to calculate variance" });
  }
});

module.exports = router;
