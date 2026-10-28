const express = require('express');
const router = express.Router();
const Visitor = require('../../models/recipe/Visitor');

function pad(n) {
  return String(n).padStart(2, '0');
}

function todayStr() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function dateRanges() {
  const now = new Date();
  const monday = new Date(now);
  const day = (now.getDay() + 6) % 7; // 0 = Monday
  monday.setDate(now.getDate() - day);
  const weekStart = `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
  const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  return { weekStart, monthStart };
}

async function sumVisits(gte) {
  const agg = await Visitor.aggregate([
    { $match: { date: { $gte: gte } } },
    { $group: { _id: null, total: { $sum: '$count' } } },
  ]);
  return agg[0]?.total || 0;
}

async function getStats(todayCount) {
  const { weekStart, monthStart } = dateRanges();
  const [week, month, totalAgg] = await Promise.all([
    sumVisits(weekStart),
    sumVisits(monthStart),
    Visitor.aggregate([{ $group: { _id: null, total: { $sum: '$count' } } }]),
  ]);
  return {
    today: todayCount,
    week,
    month,
    total: totalAgg[0]?.total || 0,
  };
}

router.get('/', async (req, res) => {
  try {
    const todayDoc = await Visitor.findOne({ date: todayStr() });
    res.json(await getStats(todayDoc?.count || 0));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const doc = await Visitor.findOneAndUpdate(
      { date: todayStr() },
      { $inc: { count: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json(await getStats(doc.count));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
