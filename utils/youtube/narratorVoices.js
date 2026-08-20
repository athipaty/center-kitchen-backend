// Locale -> default storyteller/narrator voice, shared between series creation (routes/youtube),
// outline drafting (claudeScript.js), and the actual TTS step (youtubeEpisodeScheduler.js) — kept
// in one place so all three agree on what "the default for this locale" means. Split out from the
// scheduler (which used to own this map alone) once claudeScript.js also needed it for outline
// drafts, to avoid a require cycle (the scheduler already requires claudeScript.js).
const NARRATOR_VOICE_BY_LOCALE = {
  "en-US": "en-US-AndrewNeural",
  "th-TH": "th-TH-NiwatNeural",
};
const DEFAULT_NARRATOR_VOICE = "en-US-AndrewNeural";

function defaultNarratorVoice(voiceLocale) {
  return NARRATOR_VOICE_BY_LOCALE[voiceLocale] || DEFAULT_NARRATOR_VOICE;
}

module.exports = { NARRATOR_VOICE_BY_LOCALE, DEFAULT_NARRATOR_VOICE, defaultNarratorVoice };
