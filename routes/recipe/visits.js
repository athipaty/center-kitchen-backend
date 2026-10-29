const express = require('express');
const router = express.Router();
const Visitor = require('../../models/recipe/Visitor');

const TZ = 'Asia/Singapore';

function pad(n) {
  return String(n).padStart(2, '0');
}

// Render's servers run on UTC regardless of the chosen region, so "today" is
// computed from the Singapore calendar date, not the server's local clock.
function sgDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return parts.reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
}

function todayStr() {
  const { year, month, day } = sgDateParts();
  return `${year}-${month}-${day}`;
}

function dateRanges() {
  const { year, month, day } = sgDateParts();
  // Treat the SG calendar date as a UTC date purely for day-of-week/month
  // arithmetic — avoids re-introducing server-timezone drift.
  const today = new Date(`${year}-${month}-${day}T00:00:00Z`);
  const dow = (today.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - dow);
  const weekStart = monday.toISOString().slice(0, 10);
  const monthStart = `${year}-${month}-01`;
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
