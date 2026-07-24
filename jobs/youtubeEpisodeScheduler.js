const cron = require("node-cron");
const sharp = require("sharp");
const axios = require("axios");
const Series = require("../models/youtube/Series");
const Character = require("../models/youtube/Character");
const Episode = require("../models/youtube/Episode");
const { generateImage } = require("../utils/youtube/pollinations");
const { synthesize } = require("../utils/youtube/edgeTts");
const { generateScript, summarizeEpisode, generateYoutubeMetadata, EXPRESSIONS } = require("../utils/youtube/claudeScript");
const { renderEpisodeToBuffer } = require("../utils/youtube/remotionRender");
const { uploadToB2, deleteB2File, b2KeyFromUrl } = require("../utils/b2Utils");
const { uploadVideoToYoutube } = require("../utils/youtube/youtubeUpload");

let io = null;

// No official voice list is stable enough to hardcode broadly — these are just sane per-locale
// narrator defaults, confirmed live against edge-tts-universal's VoicesManager during development.
const NARRATOR_VOICE_BY_LOCALE = {
  "en-US": "en-US-AndrewNeural",
  "th-TH": "th-TH-NiwatNeural",
};
const DEFAULT_NARRATOR_VOICE = "en-US-AndrewNeural";

// Pollinations' anonymous tier is rate-limited to ~1 request/15s — every loop below is
// deliberately sequential (never Promise.all) and pauses between calls rather than trying to
// parallelize, which would just trade a clean 429 for one that's harder to reason about.
const POLLINATIONS_DELAY_MS = 16000;
// edge-tts-universal has no documented rate limit, but firing dozens of lines back-to-back with
// zero spacing (now that episodes run 8-12 scenes instead of 3-5) is what made NoAudioReceived
// start showing up — a small gap between lines costs little next to the render step's own runtime.
const TTS_DELAY_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function emit(episode, extra = {}) {
  io?.emit("episode:progress", {
    episodeId: String(episode._id),
    status: episode.status,
    statusDetail: episode.statusDetail,
    ...extra,
  });
}

// pending -> script: writes the scene-by-scene script, fed the series' continuity log so plot
// stays consistent with prior episodes.
async function stepScript(episode) {
  const series = await Series.findById(episode.series);
  const characters = await Character.find({ series: episode.series });
  episode.statusDetail = "writing script";
  await episode.save();
  await emit(episode);

  const { title, scenes } = await generateScript(series, characters, episode.premise);
  episode.title = title;
  episode.scenes = scenes;
  episode.status = "script";
  episode.statusDetail = "";
}

// Generates one character's locked sprite set (one image per EXPRESSION) — shared by the episode
// pipeline (stepSprites below) and the standalone POST /characters/:id/generate-sprites route,
// since a character can get its sprites generated either up front on the Series page or lazily
// the first time an episode references it. `onProgress(expression)` is optional, used to keep an
// Episode's statusDetail live while this runs as part of that pipeline.
//
// The bare expression word ("happy expression") was too weak a signal — diffusion models render
// it as a subtle, easy-to-miss facial tweak. These need to read at a glance, so each one spells
// out exaggerated face + pose cues instead of leaving the model to infer them.
// "action" (a pose, not an emotion) was replaced with "angry" — an actual emotion, and a more
// useful complement to happy/sad/surprised for dialogue-driven scenes.
// These 5 additions were picked for genre fit rather than a generic full emotional range —
// this is a comedic everyday-life series (per the series' own "fun + comedic" tone field), which
// leans on curious/confused/embarrassed/laughing reaction shots far more than e.g. "scared" or
// "sleepy" would come up.
const EXPRESSION_DETAILS = {
  neutral: "calm relaxed neutral face, soft gentle closed-mouth expression, relaxed shoulders",
  happy: "huge joyful open-mouth smile, eyes crinkled shut with happiness, rosy cheeks, relaxed shoulders",
  sad: "big exaggerated frown, downturned mouth, glassy teary eyes, eyebrows angled up in sorrow, shoulders slumped and drooping, head hung low",
  surprised: "eyes wide open like saucers, eyebrows shot up high, mouth open in a shocked round gasp, hands jumped up near face, body leaning back in surprise",
  angry: "furious scowl, furrowed angry eyebrows pressed down, gritted clenched teeth, clenched fists raised, red angry cheeks, aggressive leaning-forward posture",
  curious: "head tilted to one side, one eyebrow raised high, eyes wide and intently focused, mouth slightly open in wonder, one hand touching chin thoughtfully, body leaning forward toward something interesting",
  excited: "eyes sparkling wide open, huge open-mouth grin, both fists pumped up near shoulders, bouncing on toes, entire body leaning forward with eager energy",
  laughing: "head tilted back, mouth wide open in a big laugh, eyes squeezed shut with mirth, one hand clutching stomach, body bent slightly forward with laughter",
  confused: "eyebrows scrunched together with one raised and one lowered, head tilted, mouth twisted to one side in puzzlement, one hand scratching head, shoulders shrugged",
  embarrassed: "bright red blushing cheeks, awkward closed-mouth smile, eyes glancing sideways avoiding contact, one hand rubbing back of neck, shoulders hunched inward shyly",
};
//
// Pollinations' documented GET endpoint (image.pollinations.ai/prompt/...) has no negative-prompt
// param despite some third-party docs claiming otherwise — confirmed against the official
// APIDOCS.md, which only lists prompt/model/width/height/seed/nologo/enhance/private. So the only
// lever against the model's tendency to populate a scene with extra background figures is
// repeating the single-subject constraint in plain positive language, several times, in different
// words, front and back of the prompt. Spot-checked several generations with this phrasing —
// consistently single-character, a clear improvement over a single "solo" mention.
function buildSpritePrompt(character, expression) {
  const expressionDetail = EXPRESSION_DETAILS[expression] || `${expression} expression`;
  return `single character portrait, exactly one (1) person only, ${character.description}, ${expressionDetail}, exaggerated clearly readable emotion, upper body portrait, head shoulders and chest only, cropped at the waist, close-up bust shot, solo, alone, no other people, no second character, no crowd, no background figures, isolated on a plain white background, simple flat vector cartoon character illustration, character reference sheet`;
}

// Fraction of the generated square image's height to keep, top-down. The "upper body only" prompt
// wording in buildSpritePrompt is unreliable on its own — spot-checked several generations and the
// model happily drew full legs and feet for any expressive pose (raised arms, running), negation
// phrasing included, which is a known limitation of prompt-only control. Cropping the output is
// the only way to *guarantee* upper-body framing regardless of what the model actually drew.
const UPPER_BODY_CROP_FRACTION = 0.6;

// The seed is baked into the filename so a regenerated sprite gets a brand-new URL — sprite
// URLs sit behind a CDN (cdn.bidhubthai.com) caching for hours, and reusing the same key would
// mean the new image never actually reaches viewers regardless of how hard they refresh.
async function generateSpriteImage(character, expression, seed) {
  const prompt = buildSpritePrompt(character, expression);
  const rawBuffer = await generateImage(prompt, { width: 768, height: 768, seed });
  const meta = await sharp(rawBuffer).metadata();
  const width = meta.width || 768;
  const height = meta.height || 768;
  const buffer = await sharp(rawBuffer)
    .extract({ left: 0, top: 0, width, height: Math.round(height * UPPER_BODY_CROP_FRACTION) })
    .jpeg()
    .toBuffer();
  return uploadToB2(buffer, `youtube/characters/${character._id}/${expression}-${seed}.jpg`, "image/jpeg");
}

async function generateCharacterSprites(character, onProgress) {
  const oldSprites = character.sprites; // deleted from B2 below once the new batch is safely saved
  character.status = "generating_sprites";
  character.sprites = [];
  await character.save();
  for (const expression of EXPRESSIONS) {
    if (onProgress) await onProgress(expression);
    try {
      const url = await generateSpriteImage(character, expression, 1);
      character.sprites.push({ expression, imageUrl: url, seed: 1 });
    } catch (e) {
      character.status = "error";
      character.spriteError = e.message;
      await character.save();
      throw new Error(`sprite generation failed for ${character.name} (${expression}): ${e.message}`);
    }
    await sleep(POLLINATIONS_DELAY_MS);
  }
  character.status = "ready";
  await character.save();

  // Best-effort — an old file surviving as an orphan is harmless, so a delete failure here
  // shouldn't affect the (already-successful) generation result.
  for (const old of oldSprites) {
    await deleteB2File(b2KeyFromUrl(old.imageUrl)).catch(() => {});
  }
}

// Redo a single expression without touching the other already-approved sprites — the common
// case is "4 of 5 are fine, just the sad one came out wrong". Uses a fresh random seed (not the
// batch's fixed seed=1) since re-running the exact same prompt+seed would just reproduce the
// same unwanted image.
async function regenerateCharacterSprite(character, expression) {
  if (!EXPRESSIONS.includes(expression)) {
    throw new Error(`Unknown expression: ${expression}`);
  }
  const seed = Math.floor(Math.random() * 1e9);
  const url = await generateSpriteImage(character, expression, seed);
  const sprite = { expression, imageUrl: url, seed };
  const idx = character.sprites.findIndex((s) => s.expression === expression);
  const oldSprite = idx >= 0 ? character.sprites[idx] : null;
  if (idx >= 0) character.sprites[idx] = sprite;
  else character.sprites.push(sprite);
  character.markModified("sprites"); // direct index assignment above isn't always tracked otherwise

  if (character.status !== "ready" && EXPRESSIONS.every((e) => character.sprites.some((s) => s.expression === e))) {
    character.status = "ready";
    character.spriteError = null;
  }
  await character.save();

  // Best-effort — an old file surviving as an orphan is harmless, so a delete failure here
  // shouldn't affect the (already-successful) regeneration result.
  if (oldSprite) await deleteB2File(b2KeyFromUrl(oldSprite.imageUrl)).catch(() => {});
}

// Generates only the expressions a character doesn't have yet — for when EXPRESSIONS grows
// (e.g. adding "curious"/"excited"/etc. to an existing 5) and already-'ready' characters need
// the new ones added on top, without regenerating (and losing seed continuity on) the sprites
// that already exist. Each missing expression reuses regenerateCharacterSprite's push-if-absent
// behavior one at a time, same throttling as the initial batch generation.
async function backfillMissingSprites(character, onProgress) {
  const missing = EXPRESSIONS.filter((e) => !character.sprites.some((s) => s.expression === e));
  for (const expression of missing) {
    if (onProgress) await onProgress(expression);
    await regenerateCharacterSprite(character, expression);
    await sleep(POLLINATIONS_DELAY_MS);
  }
  return missing;
}

// script -> sprites: generates sprite sets for any NEW character this episode references (skips
// characters already status:'ready' — the entire point of generating sprites once and reusing
// them forever).
async function stepSprites(episode) {
  const characterIds = [
    ...new Set(episode.scenes.flatMap((s) => s.charactersOnScreen.map(String))),
  ];
  const characters = await Character.find({ _id: { $in: characterIds } });
  const needSprites = characters.filter((c) => c.status !== "ready");

  for (const character of needSprites) {
    await generateCharacterSprites(character, async (expression) => {
      episode.statusDetail = `${character.name} sprite: ${expression}`;
      await episode.save();
      await emit(episode);
    });
  }

  episode.status = "sprites";
  episode.statusDetail = "";
}

// Pollinations' documented GET endpoint has no negative-prompt param (see buildSpritePrompt's
// comment above) — a single trailing "no characters, no people" was too weak a signal, and scenes
// routinely came back with people baked into the scenery itself, which then stay on screen for the
// whole scene regardless of who's actually speaking (the Scene.tsx portrait-overlay logic only
// controls the separate circular speaker portrait — it has no way to remove figures the background
// image itself already contains). Same fix as sprites: repeat the "empty, uninhabited" constraint
// several times, in different words, front and back of the prompt.
function buildBackgroundPrompt(scene, series) {
  const styleSuffix = series.artStyle ? `, ${series.artStyle}` : "";
  return `empty background scenery, uninhabited location, nobody present, vacant${styleSuffix}, ${scene.backgroundPrompt}, wide establishing shot of the location only, no characters, no people, no person, no human figures, no silhouettes, no crowd, background art only, scenery without any inhabitants`;
}

// sprites -> backgrounds: one image per scene, using the series' shared artStyle suffix so every
// scene (and every episode) looks like the same visual world.
async function stepBackgrounds(episode) {
  const series = await Series.findById(episode.series);
  for (const scene of episode.scenes) {
    if (scene.backgroundUrl) continue; // already generated — resuming after an interruption
    episode.statusDetail = `background for scene ${scene.order + 1}/${episode.scenes.length}`;
    await episode.save();
    await emit(episode);
    const prompt = buildBackgroundPrompt(scene, series);
    const buffer = await generateImage(prompt, { width: 1280, height: 720 });
    scene.backgroundUrl = await uploadToB2(
      buffer,
      `youtube/episodes/${episode._id}/scene${scene.order}-bg.jpg`,
      "image/jpeg"
    );
    await sleep(POLLINATIONS_DELAY_MS);
  }
  episode.status = "backgrounds";
  episode.statusDetail = "";
}

// Redo a single scene's background art using its already-saved backgroundPrompt, without touching
// any other scene or requiring the prompt text itself to have changed — the review panel's
// standalone "reroll this background" button, as opposed to stepBackgrounds' initial per-scene
// generation. Uses a fresh random seed (stepBackgrounds passes none) and a seed-tagged B2 key so
// re-running the same prompt gets a new image rather than reproducing (or being served a cached
// copy of) the same unwanted one — same reasoning as regenerateCharacterSprite above.
async function regenerateSceneBackground(episode, scene) {
  const series = await Series.findById(episode.series);
  const seed = Math.floor(Math.random() * 1e9);
  const prompt = buildBackgroundPrompt(scene, series);
  const buffer = await generateImage(prompt, { width: 1280, height: 720, seed });
  const oldUrl = scene.backgroundUrl;
  scene.backgroundUrl = await uploadToB2(
    buffer,
    `youtube/episodes/${episode._id}/scene${scene.order}-bg-${seed}.jpg`,
    "image/jpeg"
  );
  episode.markModified("scenes");
  await episode.save();

  // Best-effort — an old file surviving as an orphan is harmless, so a delete failure here
  // shouldn't affect the (already-successful) regeneration result.
  if (oldUrl) await deleteB2File(b2KeyFromUrl(oldUrl)).catch(() => {});
}

// backgrounds -> review: one audio file per dialogue line, then STOPS at "review" instead of
// going straight into rendering — gives a human a chance to read the dialogue, look at the
// backgrounds, and edit anything before the render (which is comparatively expensive/slow) runs.
// Narrator lines use a per-locale default voice; character lines use that character's own locked
// voiceName.
async function stepTts(episode) {
  const series = await Series.findById(episode.series);
  const characters = await Character.find({ series: episode.series });
  const byId = new Map(characters.map((c) => [String(c._id), c]));
  const narratorVoice = NARRATOR_VOICE_BY_LOCALE[series.voiceLocale] || DEFAULT_NARRATOR_VOICE;

  for (const scene of episode.scenes) {
    for (let i = 0; i < scene.dialogue.length; i++) {
      const line = scene.dialogue[i];
      if (line.audioUrl) continue; // already generated — resuming after an interruption
      episode.statusDetail = `narration for scene ${scene.order + 1} line ${i + 1}`;
      await episode.save();
      await emit(episode);
      const voice = line.character ? byId.get(String(line.character))?.voiceName || narratorVoice : narratorVoice;
      const { buffer, durationMs } = await synthesize(line.text, voice);
      line.audioUrl = await uploadToB2(
        buffer,
        `youtube/episodes/${episode._id}/scene${scene.order}-line${i}.mp3`,
        "audio/mpeg"
      );
      line.durationMs = durationMs;
      await sleep(TTS_DELAY_MS);
    }
  }
  episode.status = "review";
  episode.statusDetail = "";
}

// Builds one scene's per-line render props. Every line still lists ALL of that scene's on-screen
// characters (each tagged with a stable left-to-right `slot`), but Scene.tsx only renders the one
// matching `speaker` for a given line — the slot is what keeps a character's portrait anchored to
// the same edge across the scene instead of jumping as the speaker changes. Each character's
// sprite reflects their most recently-voiced expression (defaulting to neutral before their first
// line), so their face doesn't reset to neutral on lines where someone else is speaking.
function buildDialogueProps(scene, byId) {
  const currentExpression = new Map();
  for (const charId of scene.charactersOnScreen) currentExpression.set(String(charId), "neutral");

  return scene.dialogue.map((line) => {
    const character = line.character ? byId.get(String(line.character)) : null;
    if (character) currentExpression.set(String(character._id), line.expression);

    const characters = scene.charactersOnScreen
      .map((id) => byId.get(String(id)))
      .filter(Boolean)
      .map((c, slot) => {
        const expr = currentExpression.get(String(c._id)) || "neutral";
        const sprite = c.sprites.find((s) => s.expression === expr) || c.sprites[0];
        return sprite ? { name: c.name, spriteUrl: sprite.imageUrl, slot } : null;
      })
      .filter(Boolean);

    return {
      text: line.text,
      speaker: character ? character.name : null,
      audioUrl: line.audioUrl,
      durationMs: line.durationMs,
      characters,
    };
  });
}

// review -> rendered: renders the MP4 (via the Remotion subprocess) and uploads it to B2, then
// STOPS at "rendered" instead of continuing straight to YouTube — gives a human a chance to
// preview the actual rendered video (via the player on the episode card) and decide to publish it,
// rather than every render silently going live on the channel the moment it finishes. If this is
// interrupted before reaching "rendered", retrying just re-renders from the already-cached
// background/sprite/audio URLs above (no repeated Pollinations/TTS calls, so it's cheap and safe
// to redo).
async function stepRenderAndUpload(episode) {
  const characterIds = [
    ...new Set(episode.scenes.flatMap((s) => s.charactersOnScreen.map(String))),
  ];
  const characters = await Character.find({ _id: { $in: characterIds } });
  const byId = new Map(characters.map((c) => [String(c._id), c]));

  episode.status = "rendering";
  episode.statusDetail = "rendering video";
  await episode.save();
  await emit(episode);

  const props = {
    scenes: episode.scenes.map((scene) => ({
      backgroundUrl: scene.backgroundUrl,
      cameraMove: scene.cameraMove,
      dialogue: buildDialogueProps(scene, byId),
    })),
    bgmUrl: null, // no royalty-free track bundled in v1 — see remotion/src/EpisodeComposition.tsx
  };

  const mp4Buffer = await renderEpisodeToBuffer(props, String(episode._id));

  episode.status = "uploading";
  episode.statusDetail = "uploading video";
  await episode.save();
  await emit(episode);

  episode.videoUrl = await uploadToB2(mp4Buffer, `youtube/episodes/${episode._id}/final.mp4`, "video/mp4");
  episode.status = "rendered";
  episode.statusDetail = "";
}

// uploading -> publishing: pushes the B2-hosted MP4 to the actual YouTube channel via the Data API
// (videos.insert), as a private upload — a human still reviews and flips visibility in YouTube
// Studio before it goes public. Re-fetches the buffer from B2 (rather than threading it through
// from stepRenderAndUpload) since each step reloads the episode fresh from Mongo on its own tick.
// Only reached via the explicit POST /episodes/:id/upload-youtube route below (same "momentary
// handoff" trick as approve-render uses with "tts": that route sets status to "uploading" and
// triggers the scheduler, which dispatches straight to this handler) — never automatically, since
// "rendered" itself has no STEP_HANDLERS entry.
async function stepPublishToYoutube(episode) {
  const series = await Series.findById(episode.series);
  episode.statusDetail = "uploading to YouTube";
  await episode.save();
  await emit(episode);

  const meta = await generateYoutubeMetadata(series, episode);
  const { data: mp4Buffer } = await axios.get(episode.videoUrl, { responseType: "arraybuffer" });
  const { videoId, url } = await uploadVideoToYoutube(Buffer.from(mp4Buffer), meta);
  episode.youtubeVideoId = videoId;
  episode.youtubeUrl = url;
  episode.status = "publishing";
  episode.statusDetail = "";
}

// publishing -> done: summarizes the episode into the series' continuity log so the NEXT episode's
// script prompt remembers what happened here.
async function stepDone(episode) {
  const series = await Series.findById(episode.series);
  const summary = await summarizeEpisode(series, episode);
  series.continuityLog.push({ episodeNumber: episode.episodeNumber, summary });
  await series.save();
  episode.status = "done";
  episode.statusDetail = "";
}

const STEP_HANDLERS = {
  pending: stepScript,
  script: stepSprites,
  sprites: stepBackgrounds,
  backgrounds: stepTts,
  tts: stepRenderAndUpload,
  rendering: stepRenderAndUpload, // safe to redo — see stepRenderAndUpload's comment
  uploading: stepPublishToYoutube,
  publishing: stepDone,
};

// Guards a single episode against being processed by two callers at once — the 30s cron sweep
// (runDueTick) and an explicit triggerNow() (called right after episode creation, retry,
// approve-render, and the review edit-cascade) are otherwise completely unsynchronized, and a
// step like stepRenderAndUpload legitimately takes well over 30s. Without this, the cron tick can
// fire mid-render and start a second concurrent render of the same episode, and the two runs stomp
// on each other's identically-named temp files in remotionRender.js (surfaced as an ENOENT on the
// output MP4 — one process deleting/overwriting what the other was still reading/writing).
const inFlightEpisodes = new Set();

async function processOne(episode) {
  const id = String(episode._id);
  if (inFlightEpisodes.has(id)) return;
  inFlightEpisodes.add(id);
  try {
    const handler = STEP_HANDLERS[episode.status];
    if (!handler) return; // 'done' or 'error' — nothing to do
    await handler(episode);
    await episode.save();
    await emit(episode);
  } catch (err) {
    episode.status = "error";
    episode.errorMessage = err.message;
    episode.statusDetail = "";
    await episode.save();
    io?.emit("episode:error", { episodeId: id, error: err.message });
  } finally {
    inFlightEpisodes.delete(id);
  }
}

let _tickRunning = false;
async function runDueTick() {
  if (_tickRunning) return; // concurrency guard — same reasoning as trackerScheduler's _dueChecksRunning
  _tickRunning = true;
  try {
    const due = await Episode.find({ status: { $nin: ["done", "error"] } });
    // Sequential, not Promise.all — every step ultimately bottlenecks on the same rate-limited
    // Pollinations calls, so running episodes concurrently wouldn't actually go faster.
    for (const episode of due) await processOne(episode);
  } finally {
    _tickRunning = false;
  }
}

function start(socketIo) {
  io = socketIo;
  // There's no natural "due" timestamp here (unlike trackerScheduler's nextCheck) — the real
  // trigger path is triggerNow(), called immediately after episode creation. This sweep is only
  // a safety net for recovering anything left mid-pipeline by a server restart.
  cron.schedule("*/30 * * * * *", runDueTick);
}

async function triggerNow(episodeId) {
  const episode = await Episode.findById(episodeId);
  if (episode) await processOne(episode);
}

module.exports = { start, triggerNow, generateCharacterSprites, regenerateCharacterSprite, backfillMissingSprites, regenerateSceneBackground };
