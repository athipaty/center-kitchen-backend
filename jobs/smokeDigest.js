// Smoke Finder moderator summary on the phone (ntfy, see routes/smoke/notify.js):
// - every Monday 09:00 Singapore time: the last 7 days in numbers
// - every day 09:00: a warning if the map data hasn't been refreshed for 9+ days
//   (the weekly GitHub refresh failed), at most every 3 days
// Counts only: no locations, no device ids.
const cron = require("node-cron");
const mongoose = require("mongoose");
const SmokeStat = require("../models/smoke/SmokeStat");
const SmokeDevice = require("../models/smoke/SmokeDevice");
const SmokeSpot = require("../models/smoke/SmokeSpot");
const SmokeReport = require("../models/smoke/SmokeReport");
const { notifyModerator } = require("../routes/smoke/notify");
const { sgDay } = require("../routes/smoke/stats");

const STALE_DAYS = 9;
const STALE_REPEAT_DAYS = 3;
const REFRESH_RUNS_URL = "https://github.com/athipaty/smoke-finder/actions/workflows/refresh-data.yml";

const metaCol = () => mongoose.connection.db.collection("smokemeta");

// Claims `id` for this period so a restart or a second instance doesn't send twice.
async function claim(id, period) {
  const res = await metaCol().updateOne({ _id: id, period: { $ne: period } }, { $set: { period, sentAt: new Date() } }, { upsert: true }).catch((err) => {
    if (err.code === 11000) return { modifiedCount: 0, upsertedCount: 0 }; // already claimed
    throw err;
  });
  return res.modifiedCount + res.upsertedCount > 0;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const daysSince = (date) => Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000);

async function weeklySummary() {
  const from7 = sgDay(-7);
  const to = sgDay(-1); // the 7 full days before today
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [days, actives, newDevices, visible, verified, hiddenThisWeek, openReports, meta] = await Promise.all([
    SmokeStat.find({ _id: { $gte: from7, $lte: to } }).lean(),
    SmokeDevice.countDocuments({ days: { $elemMatch: { $gte: from7, $lte: to } } }),
    SmokeDevice.countDocuments({ first: { $gte: from7, $lte: to } }),
    SmokeSpot.countDocuments({ status: { $ne: "hidden" } }),
    SmokeSpot.countDocuments({ status: "verified" }),
    SmokeSpot.countDocuments({ status: "hidden", updatedAt: { $gte: weekAgo } }),
    SmokeReport.countDocuments({ status: "open" }),
    metaCol().findOne({ _id: "current" }, { projection: { importedAt: 1 } }),
  ]);
  const sum = (key) => days.reduce((n, d) => n + (key.split(".").reduce((o, k) => o?.[k], d) ?? 0), 0);
  const reports = sum("votes.gone") + sum("votes.not_allowed");

  return [
    `People: ${plural(actives, "phone")} used the app, ${newDevices} new.`,
    `Use: ${plural(sum("checks"), "check")}, ${sum("nearby")} Nearby, ${plural(sum("searches"), "search", "searches")}, ${plural(sum("checkins"), "check-in")}.`,
    `Spots: ${sum("adds")} added, ${plural(reports, "Gone/Not allowed vote")}, ${hiddenThisWeek} hidden. Now ${visible} visible (${verified} verified).`,
    `Problem reports waiting: ${openReports}.`,
    meta?.importedAt ? `Map data: imported ${daysSince(meta.importedAt)} days ago.` : "Map data: not imported yet.",
  ].join("\n");
}

async function runWeekly() {
  if (!(await claim("digestWeekly", sgDay()))) return;
  notifyModerator("Smoke Finder: last 7 days", await weeklySummary());
}

async function runStaleCheck() {
  const meta = await metaCol().findOne({ _id: "current" }, { projection: { importedAt: 1 } });
  if (!meta?.importedAt) return;
  const age = daysSince(meta.importedAt);
  if (age < STALE_DAYS) return;
  // One warning per STALE_REPEAT_DAYS-day period.
  if (!(await claim("digestStale", `${Math.floor(Date.now() / (STALE_REPEAT_DAYS * 86_400_000))}`))) return;
  notifyModerator(
    `Smoke Finder: map data is ${age} days old`,
    `The weekly refresh hasn't imported new data since ${new Date(meta.importedAt).toISOString().slice(0, 10)}. Check the GitHub runs: ${REFRESH_RUNS_URL}`
  );
}

function start() {
  if (!(process.env.SMOKE_NTFY_TOPIC || process.env.NTFY_TOPIC)) {
    console.log("smokeDigest: no ntfy topic, moderator summary disabled");
    return;
  }
  const opts = { timezone: "Asia/Singapore" };
  const log = (name) => (err) => console.error(`[smokeDigest] ${name} error:`, err.message);
  cron.schedule("0 9 * * 1", () => runWeekly().catch(log("weekly")), opts);
  cron.schedule("0 9 * * *", () => runStaleCheck().catch(log("stale")), opts);
  console.log("✅ smokeDigest scheduled: Mondays 09:00 SGT, stale-data check daily 09:00");
}

module.exports = { start, weeklySummary, runStaleCheck };
