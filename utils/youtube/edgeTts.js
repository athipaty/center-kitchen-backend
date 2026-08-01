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

// Per-expression prosody nudges (rate/pitch/volume) so a line's delivery matches the emotion the
// script assigned it, instead of every line — happy, sad, angry, whatever — coming out in the same
// flat neutral read. Values are deliberately mild: edge-tts's prosody SSML is a fixed % shift over
// the whole line, not real acting, so anything more aggressive starts to sound distorted rather
// than expressive. Mirrors EXPRESSIONS in claudeScript.js; anything unlisted (or 'neutral') gets no
// adjustment.
const EXPRESSION_PROSODY = {
  happy: { rate: "+8%", pitch: "+15Hz" },
  excited: { rate: "+15%", pitch: "+25Hz", volume: "+10%" },
  laughing: { rate: "+10%", pitch: "+20Hz" },
  sad: { rate: "-12%", pitch: "-20Hz", volume: "-10%" },
  embarrassed: { rate: "-5%", pitch: "-10Hz" },
  confused: { rate: "-5%", pitch: "+5Hz" },
  angry: { rate: "+10%", pitch: "+10Hz", volume: "+15%" },
  surprised: { rate: "+12%", pitch: "+30Hz" },
  curious: { rate: "+3%", pitch: "+10Hz" },
};

async function synthesize(text, voiceName, expression) {
  const prosody = EXPRESSION_PROSODY[expression];
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const tts = new EdgeTTS(text, voiceName, prosody);
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
