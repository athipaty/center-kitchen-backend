const mongoose = require("mongoose");

// Opt-in push alerts: "tell me if the rules change at my saved spots".
// One per device (hashed id). Holds only what alerts need: the push
// subscription, the language, and the saved spots with their last verdict.
// Deleted when the user turns alerts off or the push service drops it.
const pointSchema = new mongoose.Schema(
  {
    key: { type: String, required: true }, // the app's favourite key
    label: { type: String, required: true, maxlength: 60 },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    verdict: { type: String, enum: ["green", "amber", "red"], required: true },
    rule: { type: String, default: null }, // top reason's rule, for the message
  },
  { _id: false }
);

const smokeAlertSchema = new mongoose.Schema(
  {
    device: { type: String, required: true, unique: true },
    subscription: {
      endpoint: { type: String, required: true },
      keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
    },
    lang: { type: String, default: "en" },
    points: [pointSchema],
  },
  { timestamps: true, versionKey: false, collection: "smokealerts" }
);

module.exports = mongoose.model("SmokeAlert", smokeAlertSchema);
