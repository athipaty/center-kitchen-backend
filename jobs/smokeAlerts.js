/**
 * smokeAlerts.js — tells Smoke Finder users when the rules change at their saved spots.
 *
 * After each data import (smoke-finder's `npm run import` updates smokemeta.importedAt),
 * every saved spot of every opted-in device is checked again. If a spot's verdict changed
 * (e.g. a new bus stop made it red, or a new NEA smoking area made it green), the device
 * gets one push. Runs every 30 minutes but only does work once per import.
 */
const cron = require("node-cron");
const mongoose = require("mongoose");
const SmokeAlert = require("../models/smoke/SmokeAlert");
const { checkPoint, loadEngine } = require("../routes/smoke/lib");
const { pushConfigured, messageFor, sendPush } = require("../routes/smoke/push");

const RUN_ID = "alertsRun";

// `send` is injectable for tests. Returns a summary of what happened.
async function runOnce({ force = false, send = sendPush } = {}) {
  if (!pushConfigured()) return { skipped: "push not configured" };
  const metaCol = mongoose.connection.db.collection("smokemeta");
  // Read fresh, not through lib's cache: this is how a new import is noticed.
  const [meta, lastRun] = await Promise.all([metaCol.findOne({ _id: "current" }), metaCol.findOne({ _id: RUN_ID })]);
  if (!meta?.boundary) return { skipped: "no data" };
  if (!force && lastRun?.importedAt === meta.importedAt) return { skipped: "no new import" };

  const engine = await loadEngine();
  const summary = { devices: 0, changed: 0, sent: 0, removed: 0, failed: 0 };

  for await (const alert of SmokeAlert.find().cursor()) {
    summary.devices++;
    const changes = [];
    for (const point of alert.points) {
      const result = await checkPoint({ lat: point.lat, lng: point.lng, accuracyM: 0, meta, engine });
      const rule = result.reasons[0]?.rule ?? null;
      if (result.verdict !== point.verdict) changes.push({ label: point.label, verdict: result.verdict, rule });
      point.verdict = result.verdict;
      point.rule = rule;
    }
    if (!changes.length) continue;

    summary.changed++;
    const outcome = await send(alert.toObject().subscription, await messageFor(alert.lang, changes));
    if (outcome.ok) {
      summary.sent++;
      await alert.save(); // only remember the new verdicts once the user has been told
    } else if (outcome.gone) {
      summary.removed++;
      await alert.deleteOne();
    } else {
      summary.failed++; // keep old verdicts so the next run tries again
      console.error("[smokeAlerts] push failed:", outcome.error);
    }
  }

  await metaCol.updateOne({ _id: RUN_ID }, { $set: { importedAt: meta.importedAt, ranAt: new Date(), summary } }, { upsert: true });
  return summary;
}

function start() {
  if (!pushConfigured()) {
    console.log("smokeAlerts: VAPID keys not set, alerts disabled");
    return;
  }
  const run = () =>
    runOnce()
      .then((s) => s.devices !== undefined && console.log("[smokeAlerts]", JSON.stringify(s)))
      .catch((err) => console.error("[smokeAlerts] error:", err.message));
  cron.schedule("*/30 * * * *", run);
  setTimeout(run, 60_000);
  console.log("✅ smokeAlerts scheduled: every 30 min (only acts after a new data import)");
}

module.exports = { start, runOnce };
