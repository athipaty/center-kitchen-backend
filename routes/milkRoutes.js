const express = require("express");
const router = express.Router();
const Milk = require("../models/Milk");

// ===========================
// SUMMARY ROUTE (Singapore time)
// ===========================
router.get("/summary/today", async (req, res) => {
  try {
    // Singapore is UTC+8 (no DST)
    const OFFSET_MIN = 8 * 60;

    const nowUtc = new Date();
    const sgNow = new Date(nowUtc.getTime() + OFFSET_MIN * 60 * 1000);

    const y = sgNow.getUTCFullYear();
    const m = sgNow.getUTCMonth();
    const d = sgNow.getUTCDate();

    // Convert SG midnight back to UTC boundaries for Mongo matching
    const startUtc = new Date(
      Date.UTC(y, m, d, 0, 0, 0, 0) - OFFSET_MIN * 60 * 1000
    );
    const endUtc = new Date(
      Date.UTC(y, m, d, 23, 59, 59, 999) - OFFSET_MIN * 60 * 1000
    );

    const result = await Milk.aggregate([
      { $match: { time: { $gte: startUtc, $lte: endUtc } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const total = result.length ? result[0].total : 0;
    res.json({ total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================
// CRUD
// ===========================
router.get("/", async (req, res) => {
  const data = await Milk.find().sort({ time: -1 });
  res.json(data);
});

router.post("/", async (req, res) => {
  const { amount, type, startTime, endTime } = req.body;

  if (!startTime || !endTime) {
    return res.status(400).json({ error: "Start and end time required" });
  }

  const milk = new Milk({
    amount,
    type,
    startTime,
    endTime,
    time: startTime, // use startTime as main time for grouping/summary
  });

  await milk.save();
  res.json(milk);
});

router.put("/:id", async (req, res) => {
  const { amount, startTime, endTime, type } = req.body;

  if (!startTime || !endTime) {
    return res.status(400).json({ error: "Start and end time required" });
  }

  const milk = await Milk.findByIdAndUpdate(
    req.params.id,
    {
      amount,
      type,
      startTime,
      endTime,
      time: startTime, // keep summary/chart consistent
    },
    {
      new: true,
      runValidators: true,
    }
  );

  res.json(milk);
});

router.delete("/:id", async (req, res) => {
  await Milk.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

module.exports = router;
