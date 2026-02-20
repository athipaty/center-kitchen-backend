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

module.exports = router;
