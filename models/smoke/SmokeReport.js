const mongoose = require("mongoose");

// A problem report from a Smoke Finder user ("this answer looks wrong", app
// problems). The location is stored only if the user chose to include it.
// Reports are deleted automatically 180 days after they're made.
const RETENTION_DAYS = 180;

const smokeReportSchema = new mongoose.Schema(
  {
    kind: { type: String, required: true, enum: ["wrong_answer", "spot", "app", "other"] },
    message: { type: String, default: "", maxlength: 1000 },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    // What the app showed at the time, for "wrong answer" reports.
    verdict: { type: String, enum: ["green", "amber", "red", null], default: null },
    rules: { type: [String], default: [] },
    lang: { type: String, default: "en" },
    device: { type: String, required: true }, // hashed device id, for rate limiting only
    status: { type: String, enum: ["open", "done"], default: "open", index: true },
    createdAt: { type: Date, default: () => new Date(), expires: RETENTION_DAYS * 86_400 },
  },
  { versionKey: false, collection: "smokereports" }
);
smokeReportSchema.index({ device: 1, createdAt: -1 });

module.exports = mongoose.model("SmokeReport", smokeReportSchema);
module.exports.RETENTION_DAYS = RETENTION_DAYS;
