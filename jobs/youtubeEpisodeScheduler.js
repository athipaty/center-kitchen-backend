const sharp = require("sharp");
const axios = require("axios");
const Series = require("../models/youtube/Series");
const Character = require("../models/youtube/Character");
const Episode = require("../models/youtube/Episode");
const {
  generateImageFlux,
  generateCharacterImage,
  generateCharacterReferenceImage,
  generateSceneImage,
  generateSceneWithReferences,
} = require("../utils/youtube/fal");
const { synthesize } = require("../utils/youtube/edgeTts");
const { generateScript, summarizeEpisode, generateYoutubeMetadata, EXPRESSIONS } = require("../utils/youtube/claudeScript");
const { renderEpisodeToBuffer } = require("../utils/youtube/remotionRender");
const { uploadToB2, deleteB2File, b2KeyFromUrl } = require("../utils/b2Utils");
const { uploadVideoToYoutube } = require("../utils/youtube/youtubeUpload");
const { defaultNarratorVoice } = require("../utils/youtube/narratorVoices");

let io = null;

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

// Generates one character's locked sprite set (one image per EXPRESSION). Left over from the old
// per-line sprite-swap rendering system (see stepImages below, which replaced it with single
// composed page images) — the episode pipeline no longer calls this, but it's kept in place, still
// reachable via the standalone POST /characters/:id/generate-sprites route, as the natural
// starting point if a later paid-tier phase wants identity-locked character art again.
// `onProgress(expression)` is optional, used to keep that route's progress event live while this
// runs.
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
// Repeating the single-subject constraint in plain positive language, several times, in different
// words, front and back of the prompt, is the reliable lever against the model's tendency to
// populate a portrait with extra background figures — spot-checked several generations with this
// phrasing, consistently single-character, a clear improvement over a single "solo" mention.
function buildSpritePrompt(character, expression) {
  const expressionDetail = EXPRESSION_DETAILS[expression] || `${expression} expression`;
  return `kids' animated cartoon character portrait in the style of a children's TV cartoon show, exactly one (1) person only, ${character.description}, ${expressionDetail}, exaggerated clearly readable emotion, upper body portrait, head shoulders and chest only, cropped at the waist, close-up bust shot, solo, alone, no other people, no second character, no crowd, no background figures, isolated on a plain white background, bold thick clean outlines, flat bright saturated colors, big expressive cartoon eyes, simple flat vector cartoon character illustration, NOT realistic, NOT photographic, NOT 3D render, character reference sheet`;
}

// Fraction of the generated square image's height to keep, top-down. The "upper body only" prompt
// wording in buildSpritePrompt is unreliable on its own — spot-checked several generations and the
// model happily drew full legs and feet for any expressive pose (raised arms, running), negation
// phrasing included, which is a known limitation of prompt-only control. Cropping the output is
// the only way to *guarantee* upper-body framing regardless of what the model actually drew.
const UPPER_BODY_CROP_FRACTION = 0.8;

// The seed is baked into the filename so a regenerated sprite gets a brand-new URL — sprite
// URLs sit behind a CDN (cdn.bidhubthai.com) caching for hours, and reusing the same key would
// mean the new image never actually reaches viewers regardless of how hard they refresh.
//
// referenceUrl, when given, routes through Instant Character (image-to-image) so the result keeps
// the same identity as that reference instead of being an independent generation — see callers for
// how the reference is chosen. Only a character's very first sprite ever (nothing yet to
// reference) falls back to a plain Flux text-to-image generation.
async function generateSpriteImage(character, expression, seed, referenceUrl) {
  const prompt = buildSpritePrompt(character, expression);
  const rawBuffer = referenceUrl
    ? await generateCharacterImage(prompt, referenceUrl, { seed })
    : await generateImageFlux(prompt, { width: 768, height: 768, seed });
  const meta = await sharp(rawBuffer).metadata();
  const width = meta.width || 768;
  const height = meta.height || 768;
  const buffer = await sharp(rawBuffer)
    .extract({ left: 0, top: 0, width, height: Math.round(height * UPPER_BODY_CROP_FRACTION) })
    .jpeg()
    .toBuffer();
  return uploadToB2(buffer, `youtube/characters/${character._id}/${expression}-${seed}.jpg`, "image/jpeg");
}

// Per-character mutex: generateCharacterSprites/regenerateCharacterSprite/backfillMissingSprites
// each load a character, mutate its in-memory `sprites` array, and .save() it — but nothing
// serialized that read-modify-write cycle across concurrent callers. Several episodes can be in
// flight at once and can share a character, or the episode pipeline can race a manual click on the
// Series page. When that happened, each caller started from its own already-stale snapshot of
// `sprites`, so whichever .save() landed second silently clobbered or duplicated whatever the
// first one wrote — the actual cause of duplicate sprite entries. Routing every mutation through a
// per-character queue, and re-reading the character fresh from the DB the moment it gets its turn
// (never trusting whatever snapshot the caller passed in), closes this: only one read-modify-write
// cycle for a given character is ever in flight.
const characterLocks = new Map();
function withCharacterLock(characterId, fn) {
  const key = String(characterId);
  const turn = (characterLocks.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  characterLocks.set(key, turn);
  // .finally() returns its own new promise, separate from `turn` — if `turn` rejects, this
  // discarded one rejects too, and since nothing else holds a reference to it, Node counts it as
  // an *unhandled* rejection and crashes the whole process regardless of whether the real caller
  // (below, via the returned `turn`) already caught it. The cleanup itself can't fail, so the only
  // reason this ever rejects is mirroring `turn` — swallow that here; `turn`'s rejection still
  // reaches whoever awaits/catches the value this function returns.
  turn.finally(() => {
    if (characterLocks.get(key) === turn) characterLocks.delete(key);
  }).catch(() => {});
  return turn;
}

async function refreshCharacterSprites(character) {
  // Must also pull `__v` here, not just the content fields: this runs after waiting on
  // withCharacterLock, by which point an earlier queued call may have already saved (bumping the
  // DB's __v) since `character` was first fetched in the route handler. Without re-syncing __v,
  // the later .save() below still carries the stale version and Mongoose's optimistic-concurrency
  // check rejects it with "No matching document found for id ... version N" even though the
  // sprites themselves were refreshed correctly.
  const fresh = await Character.findById(character._id).select("sprites status spriteError __v");
  character.sprites = fresh.sprites;
  character.status = fresh.status;
  character.spriteError = fresh.spriteError;
  character.__v = fresh.__v;
}

// `expressions` defaults to the full palette — used by the manual "Generate sprites" button on
// the Series page, now the only caller since the episode pipeline itself no longer generates
// sprites (see stepImages below).
async function generateCharacterSpritesInternal(character, onProgress, expressions = EXPRESSIONS) {
  const oldSprites = character.sprites; // deleted from B2 below once the new batch is safely saved
  character.status = "generating_sprites";
  character.sprites = [];
  await character.save();
  // The first expression generated in a batch has nothing to reference yet, so it's a plain Flux
  // generation and becomes the base every other expression in this batch is conditioned on —
  // anchoring the whole set to one identity instead of each being an independent generation.
  let baseImageUrl = null;
  for (const expression of expressions) {
    if (onProgress) await onProgress(expression);
    // A fresh random seed per expression, not a shared fixed one — diffusion models mostly
    // determine composition/pose from the seed, so reusing the same seed across every expression
    // in a batch produced near-identical-looking sprites regardless of how different the
    // expression wording in the prompt was (the exact failure regenerateCharacterSprite below
    // was already written to avoid, just never applied to this initial batch).
    const seed = Math.floor(Math.random() * 1e9);
    try {
      const url = await generateSpriteImage(character, expression, seed, baseImageUrl);
      if (!baseImageUrl) baseImageUrl = url;
      character.sprites.push({ expression, imageUrl: url, seed });
    } catch (e) {
      character.status = "error";
      character.spriteError = e.message;
      await character.save();
      throw new Error(`sprite generation failed for ${character.name} (${expression}): ${e.message}`);
    }
  }
  character.status = "ready";
  await character.save();

  // Best-effort — an old file surviving as an orphan is harmless, so a delete failure here
  // shouldn't affect the (already-successful) generation result.
  for (const old of oldSprites) {
    await deleteB2File(b2KeyFromUrl(old.imageUrl)).catch(() => {});
  }
}

function generateCharacterSprites(character, onProgress, expressions = EXPRESSIONS) {
  return withCharacterLock(character._id, async () => {
    await refreshCharacterSprites(character);
    return generateCharacterSpritesInternal(character, onProgress, expressions);
  });
}

// Redo a single expression without touching the other already-approved sprites — the common
// case is "4 of 5 are fine, just the sad one came out wrong". Uses a fresh random seed (not the
// batch's fixed seed=1) since re-running the exact same prompt+seed would just reproduce the
// same unwanted image.
// Prefers the "neutral" sprite as the identity anchor when one exists (most representative,
// least likely to itself be an exaggerated pose); falls back to whatever sprite happens to exist,
// or null (a brand-new character with no sprites yet at all) which generateSpriteImage treats as
// "nothing to reference, do a plain base generation instead".
function pickReferenceSprite(character) {
  const neutral = character.sprites.find((s) => s.expression === "neutral");
  return (neutral || character.sprites[0])?.imageUrl || null;
}

async function regenerateCharacterSpriteInternal(character, expression) {
  if (!EXPRESSIONS.includes(expression)) {
    throw new Error(`Unknown expression: ${expression}`);
  }
  const seed = Math.floor(Math.random() * 1e9);
  const referenceUrl = pickReferenceSprite(character);
  const url = await generateSpriteImage(character, expression, seed, referenceUrl);
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

function regenerateCharacterSprite(character, expression) {
  return withCharacterLock(character._id, async () => {
    await refreshCharacterSprites(character);
    return regenerateCharacterSpriteInternal(character, expression);
  });
}

// Generates only the expressions a character doesn't have yet, out of `expressions` (defaults to
// the full palette — for when EXPRESSIONS grows and an already-'ready' character needs the new
// ones added on top, via the standalone POST /characters/:id/backfill-sprites route).
// Each missing expression reuses regenerateCharacterSpriteInternal's push-if-absent behavior one at
// a time, same throttling as the initial batch generation — all under one lock acquisition so a
// concurrent caller can't sneak in and see a half-backfilled character.
async function backfillMissingSpritesInternal(character, onProgress, expressions = EXPRESSIONS) {
  const missing = expressions.filter((e) => !character.sprites.some((s) => s.expression === e));
  for (const expression of missing) {
    if (onProgress) await onProgress(expression);
    await regenerateCharacterSpriteInternal(character, expression);
  }
  return missing;
}

function backfillMissingSprites(character, onProgress, expressions = EXPRESSIONS) {
  return withCharacterLock(character._id, async () => {
    await refreshCharacterSprites(character);
    return backfillMissingSpritesInternal(character, onProgress, expressions);
  });
}

// Every scene image is now conditioned on each on-screen character's locked reference photo
// (FLUX.2 multi-reference editing — see generateSceneWithReferences in utils/youtube/fal.js)
// instead of relying purely on repeating their text description, which let the image model
// reinvent the character's exact look on every scene. Generated lazily, once, the first time this
// character is actually needed for a scene — reused for every scene/episode after.
//
// Two episodes sharing a character could theoretically race this on their very first shared use
// and both generate one — harmless (whichever save lands last just wins, no corruption, and the
// loser's image is simply never referenced again), not worth extra locking machinery for a
// one-time cost.
async function ensureCharacterReferenceImage(character) {
  if (character.referenceImageUrl) return character.referenceImageUrl;
  // Reuses buildSpritePrompt's "neutral" prompt — already exactly a clean, single-subject,
  // no-background identity portrait, which is exactly what a reference photo needs to be.
  const prompt = buildSpritePrompt(character, "neutral");
  const seed = Math.floor(Math.random() * 1e9);
  const rawBuffer = await generateCharacterReferenceImage(prompt, { seed });
  const meta = await sharp(rawBuffer).metadata();
  const height = meta.height || 1024;
  const buffer = await sharp(rawBuffer)
    .extract({ left: 0, top: 0, width: meta.width || 1024, height: Math.round(height * UPPER_BODY_CROP_FRACTION) })
    .jpeg()
    .toBuffer();
  const url = await uploadToB2(buffer, `youtube/characters/${character._id}/reference-${seed}.jpg`, "image/jpeg");
  character.referenceImageUrl = url;
  await Character.updateOne({ _id: character._id }, { referenceImageUrl: url });
  return url;
}

// Falls back to a kids' animated cartoon look when a series hasn't set its own artStyle — matches
// the style generateStoryOutline's own prompt suggests by example, and matches buildSpritePrompt's
// character style so scenes and characters read as the same consistent show rather than a
// storybook/painterly background clashing with cartoon characters.
const DEFAULT_SPREAD_STYLE = "kids' animated cartoon style, bold thick clean outlines, flat bright saturated colors, rounded friendly shapes, children's cartoon show background art, NOT realistic, NOT photographic, NOT painterly";

// Characters actually on screen in this scene, in a stable order — both buildCastLine's numbered
// "Reference image N" text and the image_urls array passed to generateSceneWithReferences iterate
// this same list, in this same order, so the model can bind each photo to the right name.
function sceneCast(scene, byId) {
  return scene.charactersOnScreen.map((id) => byId.get(String(id))).filter(Boolean);
}

function buildCastLine(cast) {
  if (!cast.length) return "";
  // Numbered so it lines up 1:1 with the reference images actually sent alongside this prompt
  // (see generateSceneWithReferences) — the model has no other way to know which uploaded photo
  // is supposed to be which named character in a multi-reference call.
  const lines = cast.map((c, i) => `Reference image ${i + 1} shows ${c.name}: ${c.description}.`).join(" ");
  return ` On-screen characters, each shown in a numbered reference image alongside this prompt — draw them with the exact same face, colors, and proportions as their reference photo, every time: ${lines}`;
}

// One full-frame illustration per scene (previously a two-page spread split across leftPageUrl/
// rightPageUrl). Characters are the priority subject — large, front-and-center, expressions
// clearly readable — with the background as secondary context rather than the main composition,
// and character info placed early in the prompt (word order carries real weight for a
// text-to-image model) so it doesn't get diluted by the scene description that follows.
function buildScenePrompt(scene, series, cast) {
  const styleSuffix = `, ${series.artStyle || DEFAULT_SPREAD_STYLE}`;
  const castLine = buildCastLine(cast);
  // Narrator-only scenes (no dialogue attributed to any character) have nothing on screen to
  // prioritize — falls back to a plain establishing shot instead of asking for a "primary
  // character subject" that doesn't exist here, which would just invite the model to hallucinate
  // one in.
  const framing = castLine
    ? `kids' cartoon illustration, character-focused medium shot, characters as the large, prominent, primary subject filling most of the frame, faces/expressions/poses clearly readable.${castLine} Background/setting (secondary, supporting context behind the characters): ${scene.backgroundPrompt}`
    : `kids' cartoon illustration, wide establishing shot, full scene composition, no characters present: ${scene.backgroundPrompt}`;
  return `${framing}${styleSuffix}, children's animated cartoon illustration, one consistent scene, single widescreen frame`;
}

// Generates one scene's image: with references for whoever's on screen, or a plain generation for
// an empty establishing shot — both go through FLUX.2 either way, so every scene in an episode
// shares one consistent look regardless of which path a given scene takes.
async function generateSceneImageBuffer(scene, series, cast, seed) {
  const prompt = buildScenePrompt(scene, series, cast);
  if (!cast.length) return generateSceneImage(prompt, { seed });
  return generateSceneWithReferences(prompt, cast.map((c) => c.referenceImageUrl), { seed });
}

// script -> images: generates one full-frame image per scene. Replaces the old separate
// sprite-generation and background-generation steps entirely — there's no per-character sprite to
// swap in anymore, each image is one fully-composed frame with its on-screen characters already
// baked in. Skipped per-scene if already present, so an interrupted run resumes without re-paying
// for images it already has.
async function stepImages(episode) {
  const series = await Series.findById(episode.series);
  const characterIds = [
    ...new Set(episode.scenes.flatMap((s) => s.charactersOnScreen.map(String))),
  ];
  const characters = await Character.find({ _id: { $in: characterIds } });
  const byId = new Map(characters.map((c) => [String(c._id), c]));

  // Every character in this episode needs its reference photo locked in before any scene using
  // them is generated, not just the first one to need it — otherwise the same character could get
  // a different reference (and therefore a visibly different look) partway through the episode.
  for (const character of characters) {
    if (character.referenceImageUrl) continue;
    episode.statusDetail = `reference portrait for ${character.name}`;
    await episode.save();
    await emit(episode);
    await ensureCharacterReferenceImage(character);
  }

  for (const scene of episode.scenes) {
    if (!scene.imageUrl) {
      episode.statusDetail = `scene ${scene.order + 1}/${episode.scenes.length}`;
      await episode.save();
      await emit(episode);
      // A fresh random seed per image — see generateCharacterSprites' seed=1 bug comment above for
      // why a fixed/omitted seed produces near-identical-looking images across calls.
      const seed = Math.floor(Math.random() * 1e9);
      const cast = sceneCast(scene, byId);
      const buffer = await generateSceneImageBuffer(scene, series, cast, seed);
      scene.imageUrl = await uploadToB2(
        buffer,
        `youtube/episodes/${episode._id}/scene${scene.order}.jpg`,
        "image/jpeg"
      );
      // Persisted right away rather than left for the eventual end-of-step save: if a later scene
      // in this same episode fails (a 429 that outlasts retries, a transient upload error, the
      // process itself getting restarted mid-run), this scene's image is already paid for and
      // already uploaded — losing the DB record on top of that would mean silently re-generating
      // (and re-paying fal.ai for) it on the next retry, even though `if (!scene.imageUrl)` above
      // exists specifically to skip exactly that.
      episode.markModified("scenes");
      await episode.save();
      await emit(episode);
    }
  }
  episode.status = "images";
  episode.statusDetail = "";
}

// Redo a scene's image using its already-saved backgroundPrompt, without touching any other
// scene — the review panel's standalone "reroll this image" button, as opposed to stepImages'
// initial per-scene generation. Uses its own fresh random seed and a seed-tagged B2 key so
// re-running the same prompt gets a new image rather than reproducing (or being served a cached
// copy of) the same unwanted one — same reasoning as regenerateCharacterSprite above.
async function regenerateSceneImage(episode, scene) {
  const series = await Series.findById(episode.series);
  const characters = await Character.find({ _id: { $in: scene.charactersOnScreen } });
  const byId = new Map(characters.map((c) => [String(c._id), c]));
  for (const character of characters) {
    if (!character.referenceImageUrl) await ensureCharacterReferenceImage(character);
  }
  const seed = Math.floor(Math.random() * 1e9);
  const cast = sceneCast(scene, byId);
  const buffer = await generateSceneImageBuffer(scene, series, cast, seed);
  const oldUrl = scene.imageUrl;
  scene.imageUrl = await uploadToB2(
    buffer,
    `youtube/episodes/${episode._id}/scene${scene.order}-${seed}.jpg`,
    "image/jpeg"
  );
  episode.markModified("scenes");
  await episode.save();

  // Best-effort — an old file surviving as an orphan is harmless, so a delete failure here
  // shouldn't affect the (already-successful) regeneration result.
  if (oldUrl) await deleteB2File(b2KeyFromUrl(oldUrl)).catch(() => {});
}

// images -> review: one audio file per narration segment, all read by the series' single
// narratorVoice, then STOPS at "review" instead of going straight into rendering — gives a human
// a chance to read the narration, look at the scene images, and edit anything before the render
// (which is comparatively expensive/slow) runs.
async function stepTts(episode) {
  const series = await Series.findById(episode.series);
  const narratorVoice = series.narratorVoice || defaultNarratorVoice(series.voiceLocale);

  for (const scene of episode.scenes) {
    for (let i = 0; i < scene.narration.length; i++) {
      const line = scene.narration[i];
      if (line.audioUrl) continue; // already generated — resuming after an interruption
      episode.statusDetail = `narration for scene ${scene.order + 1} line ${i + 1}`;
      await episode.save();
      await emit(episode);
      const { buffer, durationMs } = await synthesize(line.text, narratorVoice);
      line.audioUrl = await uploadToB2(
        buffer,
        `youtube/episodes/${episode._id}/scene${scene.order}-line${i}.mp3`,
        "audio/mpeg"
      );
      line.durationMs = durationMs;
      // Persisted right away, same reasoning as stepImages' per-scene save: without this, a line's
      // audio only became durable on the NEXT line's pre-generation save (or the outer step's final
      // save for the very last line) - if the process restarted mid-run before that, an
      // already-synthesized (and already B2-uploaded) line would silently redo the TTS call on
      // retry, even though `if (line.audioUrl) continue` above exists specifically to skip exactly
      // that.
      episode.markModified("scenes");
      await episode.save();
      await emit(episode);
      await sleep(TTS_DELAY_MS);
    }
  }
  episode.status = "review";
  episode.statusDetail = "";
}

// review -> rendered: renders the MP4 (via the Remotion subprocess) and uploads it to B2, then
// STOPS at "rendered" instead of continuing straight to YouTube — gives a human a chance to
// preview the actual rendered video (via the player on the episode card) and decide to publish it,
// rather than every render silently going live on the channel the moment it finishes. If this is
// interrupted before reaching "rendered", retrying just re-renders from the already-cached
// page-image/audio URLs above (no repeated Pollinations/TTS calls, so it's cheap and safe to redo).
async function stepRenderAndUpload(episode) {
  episode.status = "rendering";
  episode.statusDetail = "rendering video";
  await episode.save();
  await emit(episode);

  const props = {
    scenes: episode.scenes.map((scene) => ({
      imageUrl: scene.imageUrl,
      // Remotion's SceneProps still calls this `dialogue` (see remotion/src/types.ts) — it only
      // cares about an ordered list of {audioUrl, durationMs, text} segments to sequence, not who
      // said them, so the DB's `narration` field maps straight onto it unchanged.
      dialogue: scene.narration.map((line) => ({
        audioUrl: line.audioUrl,
        durationMs: line.durationMs,
        text: line.text,
      })),
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

// uploading -> done: pushes the B2-hosted MP4 to the actual YouTube channel via the Data API
// (videos.insert), as a private upload — a human still reviews and flips visibility in YouTube
// Studio before it goes public — then immediately summarizes the episode into the series'
// continuity log so the NEXT episode's script prompt remembers what happened here. Used to be two
// separate steps (uploading -> publishing -> done) chained by the old 30s cron sweep; now that
// every earlier stage is a manual click with no background sweep to catch a leftover "publishing"
// episode, there's no reason to pause between them — same one-call-does-several-hops reasoning as
// stepRenderAndUpload chaining rendering -> uploading -> rendered below. Re-fetches the video
// buffer from B2 (rather than threading it through from stepRenderAndUpload) since each step
// reloads the episode fresh from Mongo. Reached via the explicit POST /episodes/:id/upload-youtube
// route (same "momentary handoff" trick as approve-render uses with "tts"), a startup resume for
// an episode still at "uploading" when the process died mid-step (see start() below), or a
// POST /episodes/:id/retry after either of those failed partway.
//
// Both of those resume paths can re-enter this handler after the YouTube upload itself already
// succeeded (e.g. summarizeEpisode/series.save() is what actually failed) — unlike
// stepImages/stepTts, which already skip whatever they find per-scene/per-line, this used to
// re-run the upload unconditionally, publishing the same episode to the channel a second time as
// an untracked duplicate video. Skip the upload once youtubeVideoId is already saved, and skip
// re-appending the continuity summary once this episode's entry is already in the log, so
// re-entering this step after a partial success only redoes whatever didn't actually finish.
async function stepPublishToYoutube(episode) {
  const series = await Series.findById(episode.series);

  if (!episode.youtubeVideoId) {
    episode.statusDetail = "uploading to YouTube";
    await episode.save();
    await emit(episode);

    const meta = await generateYoutubeMetadata(series, episode);
    const { data: mp4Buffer } = await axios.get(episode.videoUrl, { responseType: "arraybuffer" });
    const { videoId, url } = await uploadVideoToYoutube(Buffer.from(mp4Buffer), meta);
    episode.youtubeVideoId = videoId;
    episode.youtubeUrl = url;
    episode.statusDetail = "";
    await episode.save();
    await emit(episode);
  }

  const alreadySummarized = series.continuityLog.some((e) => e.episodeNumber === episode.episodeNumber);
  if (!alreadySummarized) {
    const summary = await summarizeEpisode(series, episode);
    series.continuityLog.push({ episodeNumber: episode.episodeNumber, summary });
    await series.save();
  }
  episode.status = "done";
  episode.statusDetail = "";
}

const STEP_HANDLERS = {
  pending: stepScript,
  script: stepImages,
  images: stepTts,
  tts: stepRenderAndUpload,
  rendering: stepRenderAndUpload, // safe to redo — see stepRenderAndUpload's comment
  uploading: stepPublishToYoutube, // goes straight to "done" — see its comment
};

// Guards a single episode against being processed by two callers at once — every step is now only
// ever kicked off by an explicit triggerNow() (episode creation used to auto-chain through a 30s
// cron sweep; each stage is a manual click now, see routes/youtube/index.js's /advance), but two
// of those clicks can still race (e.g. a double-click, or /advance and /retry firing close
// together), and a step like stepRenderAndUpload legitimately takes well over any such gap.
// Without this, two concurrent runs of the same episode would stomp on each other's
// identically-named temp files in remotionRender.js (surfaced as an ENOENT on the output MP4 —
// one process deleting/overwriting what the other was still reading/writing).
const inFlightEpisodes = new Set();

// The actual real-time answer to "is this episode being worked on right now" — unlike its status
// field, which can now sit at a non-terminal value (e.g. "images") indefinitely while genuinely
// idle, waiting on the next manual /advance click. Delete routes use this instead of guessing
// "safe to delete" from status, since status alone can no longer tell idle-and-waiting apart from
// mid-write.
function isEpisodeInFlight(episodeId) {
  return inFlightEpisodes.has(String(episodeId));
}

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

function start(socketIo) {
  io = socketIo;
  // No ongoing background sweep — every stage (script, sprites, backgrounds, narration,
  // approve-render, upload) only ever runs when a human explicitly triggers it (a button click
  // hitting triggerNow via routes/youtube/index.js), one step at a time. A server restart mid-
  // MANUAL step (pending/script/images) just leaves that episode idle at its last-saved status
  // until the next manual click resumes it — safe, since every step already skips whatever it
  // finds already generated.
  //
  // 'tts'/'rendering'/'uploading' are different: once a human clicks "Approve & render", the
  // pipeline is supposed to run straight through to 'done' with no further clicks, so the
  // frontend shows no button for these — just a progress spinner. If the process dies mid-step
  // (e.g. a redeploy landing mid-render), the episode is left stuck forever: inFlightEpisodes is
  // gone (a fresh Set every boot) but nothing is left to ever call triggerNow again. Right after a
  // fresh boot is the one moment it's safe to assume nothing else could legitimately still be
  // working on these — there's no other instance that could be — so resume any found here, once.
  Episode.find({ status: { $in: ["tts", "rendering", "uploading"] } })
    .then((stuck) => {
      for (const episode of stuck) {
        processOne(episode).catch((e) => console.error(`startup resume failed for ${episode._id}:`, e.message));
      }
    })
    .catch((e) => console.error("startup resume sweep failed:", e.message));
}

async function triggerNow(episodeId) {
  const episode = await Episode.findById(episodeId);
  if (episode) await processOne(episode);
}

module.exports = { start, triggerNow, generateCharacterSprites, regenerateCharacterSprite, backfillMissingSprites, regenerateSceneImage, isEpisodeInFlight };
