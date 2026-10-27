// Phone alerts for moderators (ntfy.sh) when someone sends a report or adds a
// spot. Uses SMOKE_NTFY_TOPIC, or the backend's usual NTFY_TOPIC if that isn't
// set. ntfy topics are readable by anyone who knows the name, so alerts carry
// no location and only the start of a report's text.
const axios = require("axios");

const ADMIN_URL = "https://smoke-finder-eight.vercel.app/admin";
const MAX_PER_HOUR = 20; // a burst of spam shouldn't flood the phone
let sent = [];

function notifyModerator(title, message) {
  const topic = process.env.SMOKE_NTFY_TOPIC || process.env.NTFY_TOPIC;
  if (!topic) return;
  const now = Date.now();
  sent = sent.filter((t) => now - t < 3_600_000);
  if (sent.length >= MAX_PER_HOUR) return;
  sent.push(now);
  // JSON body, not headers: headers can't carry Chinese, Tamil or Thai text.
  axios
    .post("https://ntfy.sh/", { topic, title, message, tags: ["smoking"], click: ADMIN_URL }, { timeout: 10_000 })
    .catch((err) => console.error("smoke: moderator alert failed:", err.message));
}

module.exports = { notifyModerator };
