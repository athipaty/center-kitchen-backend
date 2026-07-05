const axios = require('axios');

// Broadcasts a message to every friend of the LINE Official Account tied to
// LINE_CHANNEL_ACCESS_TOKEN. Fine for personal/single-recipient use — avoids the
// extra userId-capture step a targeted push message would need. LINE Notify
// (the old simple option) was shut down by LINE on 2025-03-31.
async function lineBroadcast(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.warn('lineBroadcast: LINE_CHANNEL_ACCESS_TOKEN not set — skipping alert:', text);
    return false;
  }
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/broadcast',
      { messages: [{ type: 'text', text }] },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return true;
  } catch (err) {
    console.error('lineBroadcast: failed to send:', err.response?.data || err.message);
    return false;
  }
}

module.exports = { lineBroadcast };
