const { EdgeTTS } = require("edge-tts-universal");
const getMp3Duration = require("get-mp3-duration");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Free, keyless narration/dialogue voices via Microsoft Edge's online TTS service (reverse-
// engineered by this package — unofficial, no SLA, could break if Microsoft changes something,
// but widely used and currently working). Confirmed voices as of this integration:
// Thai: th-TH-NiwatNeural (male), th-TH-PremwadeeNeural (female).
// English (US), among others: en-US-AvaNeural, en-US-AndrewNeural, en-US-EmmaNeural.
// Full list changes over time — use VoicesManager.find({Locale:'xx-XX'}) to check before relying
// on a specific name.
//
// Retries on failure (most commonly NoAudioReceived) since this is an unofficial websocket
// connection to Microsoft's service with no documented rate limit — became noticeably flakier
// once episodes started needing dozens of lines back-to-back instead of a handful, so a transient
// drop can't just be allowed to fail the whole episode.
const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 3000;

async function synthesize(text, voiceName) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const tts = new EdgeTTS(text, voiceName);
      const result = await tts.synthesize();
      const buffer = Buffer.from(await result.audio.arrayBuffer());
      const durationMs = getMp3Duration(buffer);
      return { buffer, durationMs };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr;
}

module.exports = { synthesize };
