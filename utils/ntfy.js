const axios = require('axios');

// ntfy.sh push notifications — zero-setup alternative to LINE/Telegram bots.
// Anyone who knows NTFY_TOPIC can read (and publish to) it, so it relies on the
// topic name being unguessable rather than real auth. Fine for a personal alert.
async function ntfyPush(title, message, { priority = 'default', tags = [] } = {}) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.warn('ntfyPush: NTFY_TOPIC not set — skipping alert:', title, message);
    return false;
  }
  try {
    await axios.post(`https://ntfy.sh/${topic}`, message, {
      headers: {
        Title: title,
        Priority: priority, // 'default' | 'high' | 'urgent' | 'low' | 'min'
        Tags: tags.join(','),
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
    return true;
  } catch (err) {
    console.error('ntfyPush: failed to send:', err.response?.data || err.message);
    return false;
  }
}

module.exports = { ntfyPush };
