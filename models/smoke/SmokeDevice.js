const mongoose = require("mongoose");

// Which days a device opened Smoke Finder, for weekly actives and retention.
// Keyed by the hashed device id only (see routes/smoke/lib.js deviceHash);
// no location or anything else about the person.
const smokeDeviceSchema = new mongoose.Schema(
  {
    _id: { type: String }, // device hash
    first: { type: String, required: true }, // YYYY-MM-DD, Singapore time
    last: { type: String, required: true },
    days: { type: [String], default: [] }, // most recent 60 active days
  },
  { versionKey: false, collection: "smokedevices" }
);
smokeDeviceSchema.index({ last: 1 });
smokeDeviceSchema.index({ first: 1 });

module.exports = mongoose.model("SmokeDevice", smokeDeviceSchema);
