// Smoke Finder moderator summary on the phone (ntfy, see routes/smoke/notify.js):
// - every Monday 09:00 Singapore time: the last 7 days in numbers
// - every day 09:00: a warning if the map data hasn't been refreshed for 9+ days
//   (the weekly GitHub refresh failed), at most every 3 days
// - every day 09:00: an alert when NEA's smoking-rules page shows a newer
//   "Last updated" date than the one the app's rules were checked against
//   (RULES_CHECKED in smoke-finder/src/rules.js), once per new date
// - every day 09:10: an alert when NTU's smoking policy shows a new "as of"
//   date for its designated smoking areas (the app's copy is in smoke-finder
//   data/operator-spots.json), once per new date
// Counts only: no locations, no device ids.
const cron = require("node-cron");
const mongoose = require("mongoose");
const SmokeStat = require("../models/smoke/SmokeStat");
const SmokeDevice = require("../models/smoke/SmokeDevice");
const SmokeSpot = require("../models/smoke/SmokeSpot");
const SmokeReport = require("../models/smoke/SmokeReport");
const SmokeError = require("../models/smoke/SmokeError");
const { notifyModerator } = require("../routes/smoke/notify");
const { sgDay } = require("../routes/smoke/stats");

const STALE_DAYS = 9;
const STALE_REPEAT_DAYS = 3;
const REFRESH_RUNS_URL = "https://github.com/athipaty/smoke-finder/actions/workflows/refresh-data.yml";

const NEA_PAGE = "https://www.nea.gov.sg/our-services/smoking-prohibition/overview";
let rulesPromise;
const loadRules = () => (rulesPromise ??= import("smoke-finder/src/rules.js"));

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
  const [days, actives, newDevices, visible, verified, hiddenThisWeek, openReports, meta, errorKinds] = await Promise.all([
    SmokeStat.find({ _id: { $gte: from7, $lte: to } }).lean(),
    SmokeDevice.countDocuments({ days: { $elemMatch: { $gte: from7, $lte: to } } }),
    SmokeDevice.countDocuments({ first: { $gte: from7, $lte: to } }),
    SmokeSpot.countDocuments({ status: { $ne: "hidden" } }),
    SmokeSpot.countDocuments({ status: "verified" }),
    SmokeSpot.countDocuments({ status: "hidden", updatedAt: { $gte: weekAgo } }),
    SmokeReport.countDocuments({ status: "open" }),
    metaCol().findOne({ _id: "current" }, { projection: { importedAt: 1 } }),
    SmokeError.countDocuments({ lastAt: { $gte: weekAgo } }),
  ]);
  const sum = (key) => days.reduce((n, d) => n + (key.split(".").reduce((o, k) => o?.[k], d) ?? 0), 0);
  const reports = sum("votes.gone") + sum("votes.not_allowed");

  return [
    `People: ${plural(actives, "phone")} used the app, ${newDevices} new.`,
    `Use: ${plural(sum("checks"), "check")}, ${sum("nearby")} Nearby, ${plural(sum("searches"), "search", "searches")}, ${plural(sum("checkins"), "check-in")}.`,
    `Spots: ${sum("adds")} added, ${plural(reports, "Gone/Not allowed vote")}, ${hiddenThisWeek} hidden. Now ${visible} visible (${verified} verified).`,
    `Problem reports waiting: ${openReports}.`,
    `App errors: ${errorKinds ? `${plural(errorKinds, "kind")} seen this week (Moderation > Errors).` : "none this week."}`,
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

// "Last updated 20 August 2026" on NEA's page -> "2026-08-20", or null.
function neaUpdatedDate(html) {
  const m = /Last updated\s+(\d{1,2} [A-Za-z]+ \d{4})/.exec(html);
  const date = m && new Date(`${m[1]} 12:00 UTC`);
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

async function runNeaWatch() {
  const res = await fetch(NEA_PAGE, { headers: { "User-Agent": "Mozilla/5.0 (smoke-finder-sg rules watcher)" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`NEA page ${res.status}`);
  const updated = neaUpdatedDate(await res.text());
  if (!updated) throw new Error("NEA page: no 'Last updated' date found");
  const { RULES_CHECKED } = await loadRules();
  if (updated <= RULES_CHECKED.neaPageUpdated) return;
  if (!(await claim("digestNeaPage", updated))) return; // one alert per new NEA date
  notifyModerator(
    "Smoke Finder: NEA changed its smoking rules page",
    `NEA's page now says "Last updated ${updated}" (the app's rules were checked against ${RULES_CHECKED.neaPageUpdated}). Compare the list with the app's rules: ${NEA_PAGE}`
  );
}

// NTU's list of designated smoking areas, as last copied into the app.
const NTU_PAGE = "https://www.ntu.edu.sg/life-at-ntu/health-and-safety/policies/prohibition-of-smoking-on-ntu-campus-policy";
const NTU_LIST_AS_OF = "15 October 2025";

async function runNtuWatch() {
  const res = await fetch(NTU_PAGE, { headers: { "User-Agent": "Mozilla/5.0 (smoke-finder-sg list watcher)" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`NTU page ${res.status}`);
  const asOf = /as of (\d{1,2} [A-Za-z]+ \d{4})/.exec(await res.text())?.[1];
  if (!asOf) throw new Error("NTU page: no 'as of' date found");
  if (asOf === NTU_LIST_AS_OF) return;
  if (!(await claim("digestNtuList", asOf))) return; // one alert per new date
  notifyModerator(
    "Smoke Finder: NTU changed its smoking areas list",
    `NTU's policy now lists designated smoking areas "as of ${asOf}" (the app has the list as of ${NTU_LIST_AS_OF}). Compare it with smoke-finder data/operator-spots.json: ${NTU_PAGE}`
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
  cron.schedule("5 9 * * *", () => runNeaWatch().catch(log("NEA page")), opts);
  cron.schedule("10 9 * * *", () => runNtuWatch().catch(log("NTU page")), opts);
  console.log("✅ smokeDigest scheduled: Mondays 09:00 SGT; stale data and NEA rules page checked daily");
}

module.exports = { start, weeklySummary, runStaleCheck, runNeaWatch, neaUpdatedDate, runNtuWatch };
