const cron = require("node-cron");
const sharp = require("sharp");
const Series = require("../models/youtube/Series");
const Character = require("../models/youtube/Character");
const Episode = require("../models/youtube/Episode");
const { generateImage } = require("../utils/youtube/pollinations");
const { synthesize } = require("../utils/youtube/edgeTts");
const { generateScript, summarizeEpisode, EXPRESSIONS } = require("../utils/youtube/claudeScript");
const { renderEpisodeToBuffer } = require("../utils/youtube/remotionRender");
const { uploadToB2, deleteB2File, b2KeyFromUrl } = require("../utils/b2Utils");

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
// Upper-body framing (see buildSpritePrompt) means action can't rely on legs/kicking like a
// full-body pose would — reworked to cues visible from the chest up: torso lean, arm swing, hair
// and clothing caught in motion.
const EXPRESSION_DETAILS = {
  neutral: "calm relaxed neutral face, soft gentle closed-mouth expression, relaxed shoulders",
  happy: "huge joyful open-mouth smile, eyes crinkled shut with happiness, rosy cheeks, both arms raised in excitement, bouncy cheerful body language",
  sad: "big exaggerated frown, downturned mouth, glassy teary eyes, eyebrows angled up in sorrow, shoulders slumped and drooping, head hung low",
  surprised: "eyes wide open like saucers, eyebrows shot up high, mouth open in a shocked round gasp, hands jumped up near face, body leaning back in surprise",
  action: "intense determined expression, torso leaning forward with energy, arms pumping and swinging with motion, hair and clothing blown back, sense of speed and momentum",
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

// sprites -> backgrounds: one image per scene, using the series' shared artStyle suffix so every
// scene (and every episode) looks like the same visual world.
async function stepBackgrounds(episode) {
  const series = await Series.findById(episode.series);
  for (const scene of episode.scenes) {
    if (scene.backgroundUrl) continue; // already generated — resuming after an interruption
    episode.statusDetail = `background for scene ${scene.order + 1}/${episode.scenes.length}`;
    await episode.save();
    await emit(episode);
    const prompt = `${scene.backgroundPrompt}${series.artStyle ? `, ${series.artStyle}` : ""}, no characters, no people`;
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

// backgrounds -> tts: one audio file per dialogue line. Narrator lines use a per-locale default
// voice; character lines use that character's own locked voiceName.
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
    }
  }
  episode.status = "tts";
  episode.statusDetail = "";
}

// tts -> uploading: renders the MP4 (via the Remotion subprocess) and uploads it to B2, in one
// step rather than persisting an intermediate "rendered but not uploaded" state — if this is
// interrupted, retrying just re-renders from the already-cached background/sprite/audio URLs
// above (no repeated Pollinations/TTS calls, so it's cheap and safe to redo).
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
      dialogue: scene.dialogue.map((line) => {
        const character = line.character ? byId.get(String(line.character)) : null;
        const sprite = character?.sprites.find((s) => s.expression === line.expression) || character?.sprites[0];
        return {
          text: line.text,
          speaker: character ? character.name : null,
          spriteUrl: sprite ? sprite.imageUrl : null,
          audioUrl: line.audioUrl,
          durationMs: line.durationMs,
        };
      }),
    })),
    bgmUrl: null, // no royalty-free track bundled in v1 — see remotion/src/EpisodeComposition.tsx
  };

  const mp4Buffer = await renderEpisodeToBuffer(props, String(episode._id));

  episode.status = "uploading";
  episode.statusDetail = "uploading video";
  await episode.save();
  await emit(episode);

  episode.videoUrl = await uploadToB2(mp4Buffer, `youtube/episodes/${episode._id}/final.mp4`, "video/mp4");
  episode.status = "uploading";
  episode.statusDetail = "";
}

// uploading -> done: summarizes the episode into the series' continuity log so the NEXT episode's
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
  uploading: stepDone,
};

async function processOne(episode) {
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
    io?.emit("episode:error", { episodeId: String(episode._id), error: err.message });
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

module.exports = { start, triggerNow, generateCharacterSprites, regenerateCharacterSprite };
