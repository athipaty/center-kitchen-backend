const axios = require('axios');

// ntfy.sh push notifications — zero-setup alternative to LINE/Telegram bots.
// Anyone who knows NTFY_TOPIC can read (and publish to) it, so it relies on the
// topic name being unguessable rather than real auth. Fine for a personal alert.
//
// Uses the JSON publish endpoint rather than header-based publishing: HTTP headers
// are effectively ASCII-only, and these alerts are in Thai with emoji tags — sent as
// headers, that content silently mangles (verified: an emoji title came through as
// literal "?"). The JSON body carries UTF-8 correctly.
const PRIORITY = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };

async function ntfyPush(title, message, { priority = 'default', tags = [] } = {}) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.warn('ntfyPush: NTFY_TOPIC not set — skipping alert:', title, message);
    return false;
  }
  try {
    await axios.post('https://ntfy.sh/', {
      topic,
      title,
      message,
      priority: PRIORITY[priority] ?? PRIORITY.default,
      tags,
    });
    return true;
  } catch (err) {
    console.error('ntfyPush: failed to send:', err.response?.data || err.message);
    return false;
  }
}

module.exports = { ntfyPush };
