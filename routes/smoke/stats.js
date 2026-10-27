// Usage counting for Smoke Finder: daily counters plus a once-a-day ping per
// device. Counting never blocks or fails a request.
const SmokeStat = require("../../models/smoke/SmokeStat");
const SmokeDevice = require("../../models/smoke/SmokeDevice");

const DAY_MS = 86_400_000;
const SGT_OFFSET_MS = 8 * 3_600_000;
const KEEP_DAYS = 60;

// YYYY-MM-DD in Singapore time, `offset` days from today.
const sgDay = (offset = 0) => new Date(Date.now() + SGT_OFFSET_MS + offset * DAY_MS).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// count("checks") or count("votes.gone")
function count(field) {
  SmokeStat.updateOne({ _id: sgDay() }, { $inc: { [field]: 1 } }, { upsert: true }).catch((err) =>
    console.error("smoke: stat failed:", err.message)
  );
}

// First open of the day for this device: mark it active.
async function ping(device) {
  const today = sgDay();
  const before = await SmokeDevice.findOneAndUpdate(
    { _id: device },
    {
      $setOnInsert: { first: today },
      $set: { last: today },
      $addToSet: { days: today },
    },
    { upsert: true, new: false }
  ).lean();
  if (before?.last === today) return; // already counted today
  const inc = { actives: 1, ...(before ? {} : { newDevices: 1 }) };
  await SmokeStat.updateOne({ _id: today }, { $inc: inc }, { upsert: true });
  if (before && before.days.length >= KEEP_DAYS) {
    await SmokeDevice.updateOne({ _id: device }, { $push: { days: { $each: [], $slice: -KEEP_DAYS } } });
  }
}

module.exports = { count, ping, sgDay, addDays };
