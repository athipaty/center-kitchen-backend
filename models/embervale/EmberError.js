const mongoose = require("mongoose");

// Script errors reported by players' games, grouped: the same message at the same place is one row with a count.
// Kept small: routes/embervale/errors.js trims it to the most recent rows. Stored in "ember_errors".
const emberErrorSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // message + file + line
    msg: { type: String, default: "" },
    src: { type: String, default: "" },
    line: { type: Number, default: 0 },
    col: { type: Number, default: 0 },
    stack: { type: String, default: "" },
    version: { type: String, default: "" },
    ua: { type: String, default: "" },
    user: { type: String, default: "" },  // last account (or "guest") that hit it
    count: { type: Number, default: 0 },
    first: { type: Date, default: Date.now },
    last: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
emberErrorSchema.index({ last: -1 });

module.exports = mongoose.model("EmberError", emberErrorSchema, "ember_errors");
