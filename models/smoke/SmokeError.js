const mongoose = require("mongoose");

// App errors reported by Smoke Finder phones, grouped: one document per kind of
// error (same message and first stack line), with a count. No device id, no
// location; the page is a path only. Deleted 30 days after it was last seen.
const smokeErrorSchema = new mongoose.Schema(
  {
    _id: { type: String }, // hash of message + first stack line
    message: { type: String, required: true, maxlength: 300 },
    stack: { type: String, default: "", maxlength: 2000 }, // the first report's
    pages: { type: [String], default: [] }, // up to 5 paths, e.g. "/map"
    versions: { type: [String], default: [] }, // up to 5 app versions
    browsers: { type: [String], default: [] }, // up to 5, e.g. "Chrome Android"
    count: { type: Number, default: 0 },
    firstAt: { type: Date, default: () => new Date() },
    lastAt: { type: Date, default: () => new Date(), expires: 30 * 86_400 },
  },
  { versionKey: false, collection: "smokeerrors" }
);

module.exports = mongoose.model("SmokeError", smokeErrorSchema);
