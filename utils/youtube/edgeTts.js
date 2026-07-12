const { EdgeTTS } = require("edge-tts-universal");
const getMp3Duration = require("get-mp3-duration");

// Free, keyless narration/dialogue voices via Microsoft Edge's online TTS service (reverse-
// engineered by this package — unofficial, no SLA, could break if Microsoft changes something,
// but widely used and currently working). Confirmed voices as of this integration:
// Thai: th-TH-NiwatNeural (male), th-TH-PremwadeeNeural (female).
// English (US), among others: en-US-AvaNeural, en-US-AndrewNeural, en-US-EmmaNeural.
// Full list changes over time — use VoicesManager.find({Locale:'xx-XX'}) to check before relying
// on a specific name.
async function synthesize(text, voiceName) {
  const tts = new EdgeTTS(text, voiceName);
  const result = await tts.synthesize();
  const buffer = Buffer.from(await result.audio.arrayBuffer());
  const durationMs = getMp3Duration(buffer);
  return { buffer, durationMs };
}

module.exports = { synthesize };
