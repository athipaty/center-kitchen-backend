const Anthropic = require("@anthropic-ai/sdk");

// Same call shape used throughout routes/ebay.js: no system prompt, instructions embedded in the
// user prompt itself requesting raw JSON, fences stripped defensively before JSON.parse (Claude
// sometimes wraps JSON in ```json fences despite being told not to).
function parseJsonResponse(msg) {
  const raw = (msg.content[0]?.text || "{}")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  return JSON.parse(raw);
}

// The original 5 cover the basic emotional range; these 5 were picked to fit this series'
// actual tone (fun + comedic, per the series' own tone field) rather than a generic
// adventure/peril set — curious/confused/embarrassed/laughing are the reaction shots a
// comedic everyday-life story leans on constantly, more than e.g. "scared" or "sleepy" would be.
const EXPRESSIONS = ["neutral", "happy", "sad", "surprised", "angry", "curious", "excited", "laughing", "confused", "embarrassed"];
const CAMERA_MOVES = ["pan-left", "pan-right", "zoom-in", "zoom-out", "static"];

// Output language is pinned to the series' narration voice, independent of whatever language
// the premise/title were typed in — the TTS voice (see NARRATOR_VOICE_BY_LOCALE in
// youtubeEpisodeScheduler.js) can only read the language it's built for, so a Thai premise with
// an English-voiced series still needs an English script, and vice versa.
const SCRIPT_LANGUAGE_BY_LOCALE = {
  "en-US": "English",
  "th-TH": "Thai",
};
const DEFAULT_SCRIPT_LANGUAGE = "English";

// Locale-specific character voice pool, gender-mapped. Deliberately small and hardcoded — edge-
// tts-universal has no stable published voice list (see edgeTts.js's own comment on this), so
// outline generation picks from voices already confirmed to work rather than letting Claude
// invent a voiceName that might not exist and silently break narration later.
const CHARACTER_VOICES_BY_LOCALE = {
  "en-US": { male: "en-US-AndrewNeural", female: "en-US-AvaNeural" },
  "th-TH": { male: "th-TH-NiwatNeural", female: "th-TH-PremwadeeNeural" },
};
const DEFAULT_CHARACTER_VOICES = CHARACTER_VOICES_BY_LOCALE["en-US"];

// ~150 spoken words/minute at natural narration pace.
const WORDS_PER_MINUTE = 150;

// Fallback for series created before targetEpisodeMinutes existed on the Series schema (Mongoose
// defaults don't backfill already-saved documents) — matches the script length those series were
// originally tuned for.
const DEFAULT_TARGET_WORDS = 1000;

// Writes the next episode's scene-by-scene script. Fed the series' continuity log so the plot
// doesn't drift or contradict itself — this is the entire mechanism that makes it feel like a
// continuing series instead of one-off unrelated clips.
async function generateScript(series, characters, premise) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const characterList = characters
    .map((c) => `- ${c.name}: ${c.description}`)
    .join("\n");
  const continuityText = (series.continuityLog || [])
    .map((e) => `Episode ${e.episodeNumber}: ${e.summary}`)
    .join("\n") || "(this is the first episode — no prior history)";
  const scriptLanguage = SCRIPT_LANGUAGE_BY_LOCALE[series.voiceLocale] || DEFAULT_SCRIPT_LANGUAGE;
  const targetWords = series.targetEpisodeMinutes
    ? Math.round(series.targetEpisodeMinutes * WORDS_PER_MINUTE)
    : DEFAULT_TARGET_WORDS;
  const targetWordsCeiling = targetWords + 200;
  // Scale scene count with target length so short episodes (e.g. a 30s short at 0.5 min) aren't
  // forced into the same 10-14 scenes tuned for a ~5-minute episode. Falls back to 5 minutes (not
  // DEFAULT_TARGET_WORDS) for legacy series without targetEpisodeMinutes, since 10-14 scenes was
  // originally tuned for a 5-minute episode — this reproduces that exact range unchanged.
  const targetMinutesForScenes = series.targetEpisodeMinutes || 5;
  const sceneCountLow = Math.max(2, Math.round(targetMinutesForScenes * 2));
  const sceneCountHigh = Math.max(sceneCountLow + 1, Math.round(targetMinutesForScenes * 2.8));

  const prompt = `You are writing one episode of an ongoing narrated "motion comic" style story series.

Series: ${series.title}
Premise: ${series.premise}
Genre: ${series.genre || "n/a"}
Tone: ${series.tone || "n/a"}

Characters available (use ONLY these — do not invent new named characters):
${characterList}

Story so far:
${continuityText}

This episode's premise: ${premise}

Write the episode as ${sceneCountLow}-${sceneCountHigh} scenes. Each scene has a background description, which characters
are on screen, and a sequence of dialogue/narration lines — a hard minimum of 5 lines per scene,
never fewer. At natural narration pace, the total dialogue/narration across the whole script must
be AT LEAST ${targetWords} words — treat this as a strict floor, not a suggestion, and aim past it
(${targetWords}-${targetWordsCeiling} words) for safety margin. Undershooting this — writing a
handful of short scenes — is the single most common mistake; if you're unsure, add more scenes and
more lines per scene rather than fewer. A line with no character speaking (pure narration) is
allowed — use character "Narrator" for those, and they still count toward the word-count floor.

Somewhere in the episode, include one "curiosity beat": a character notices something (an animal,
object, or place) and asks a genuine, kid-friendly "why" or "how" question about it. Another
character answers first with a silly, made-up, non-sequitur guess, for a laugh — then the first
character (or whichever character would naturally know) gives the real answer in 1-2 simple
sentences: a small, accurate, age-appropriate fact, not a lecture. Keep it fun and brief, matching
the rest of the episode's tone.

Write the title and every dialogue/narration line in ${scriptLanguage}, regardless of what
language the premise above happens to be written in — the narrator voice can only read
${scriptLanguage}. backgroundPrompt (image generation prompts) should stay in English regardless,
since the image model doesn't need to match the narration language.

Return ONLY a raw JSON object (no markdown fences) in exactly this shape:
{
  "title": "short episode title",
  "scenes": [
    {
      "backgroundPrompt": "a vivid visual description of the setting for this scene, no characters",
      "cameraMove": "one of: ${CAMERA_MOVES.join(", ")}",
      "dialogue": [
        { "characterName": "exact name from the list above, or Narrator", "expression": "one of: ${EXPRESSIONS.join(", ")}", "text": "the line" }
      ]
    }
  ]
}`;

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 12000,
    messages: [{ role: "user", content: prompt }],
  });

  const parsed = parseJsonResponse(msg);
  const byName = new Map(characters.map((c) => [c.name.toLowerCase(), c]));

  const scenes = (parsed.scenes || []).map((s, i) => {
    const dialogue = (s.dialogue || []).map((d) => {
      const isNarrator = !d.characterName || d.characterName.toLowerCase() === "narrator";
      const char = isNarrator ? null : byName.get(String(d.characterName).toLowerCase());
      return {
        character: char ? char._id : null,
        expression: EXPRESSIONS.includes(d.expression) ? d.expression : "neutral",
        text: d.text || "",
      };
    });
    const charactersOnScreen = [...new Set(dialogue.map((d) => d.character).filter(Boolean))];
    return {
      order: i,
      backgroundPrompt: s.backgroundPrompt || "a simple background",
      cameraMove: CAMERA_MOVES.includes(s.cameraMove) ? s.cameraMove : "zoom-in",
      charactersOnScreen,
      dialogue,
    };
  });

  return { title: parsed.title || premise.slice(0, 60), scenes };
}

// Summarizes a finished episode into a couple of sentences for the series' continuity log —
// called once after an episode finishes rendering, so the NEXT episode's generateScript() call
// has a compact record of what happened instead of needing the full scene/dialogue data.
async function summarizeEpisode(series, episode) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const script = episode.scenes
    .map((s) => s.dialogue.map((d) => d.text).join(" "))
    .join(" ");

  const prompt = `Summarize this episode of "${series.title}" in 2-3 sentences, focused on plot
developments and character/relationship changes future episodes should remember. Be concise.

Episode title: ${episode.title}
Episode content: ${script}

Return ONLY a raw JSON object (no markdown fences): { "summary": "..." }`;

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const parsed = parseJsonResponse(msg);
  return parsed.summary || episode.title;
}

// Writes YouTube listing metadata (title/description/tags) the way an established channel would —
// separate from the episode's internal `title` (which drives continuity/UI), since a good SEO
// title often differs from a clean in-universe episode title.
async function generateYoutubeMetadata(series, episode) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const script = episode.scenes
    .map((s) => s.dialogue.map((d) => d.text).join(" "))
    .join(" ");

  const prompt = `You are a YouTube SEO specialist writing the public listing for one episode of an
ongoing animated "motion comic" series, the way a successful animation/storytime channel would.

Series: ${series.title}
Genre: ${series.genre || "n/a"}
Episode number: ${episode.episodeNumber}
Episode title (internal): ${episode.title}
Episode script: ${script}

Write:
1. "title": a punchy, clickable YouTube title, at most 95 characters. Include the episode number.
   No misleading clickbait — it must accurately reflect the episode.
2. "description": 150-250 words. First 1-2 lines are the hook (shown before "Show more", so make
   them count). Then a short spoiler-light summary. Then a line inviting viewers to subscribe for
   more episodes. End with 4-6 relevant hashtags on their own line (format: #Word, no spaces).
3. "tags": 15-20 individual search keywords/short-phrases (YouTube's tag field, not hashtags — no
   # symbol), ordered most-relevant first, covering the series name, genre, and general terms
   viewers of this kind of content search for.

Return ONLY a raw JSON object (no markdown fences):
{ "title": "...", "description": "...", "tags": ["...", "..."] }`;

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const parsed = parseJsonResponse(msg);
  return {
    title: (parsed.title || episode.title || series.title).slice(0, 95),
    description: parsed.description || episode.premise,
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 20) : [],
  };
}

// Suggests a single one-line children's-story idea to seed the outline wizard's idea box — for
// the "🎲 Suggest an idea" button, so a user with no idea yet has something to start from (and can
// click again for a different one). Deliberately cheap/fast (short prompt, small max_tokens) since
// this is just a starting point the user will edit or feed into generateStoryOutline next, not the
// final output. A nonce-style temperature-free "give me something different each time" instruction
// is enough in practice since each call is a fresh, independent request with no shared history.
async function suggestStoryIdea({ voiceLocale = "en-US" } = {}) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const scriptLanguage = SCRIPT_LANGUAGE_BY_LOCALE[voiceLocale] || DEFAULT_SCRIPT_LANGUAGE;

  const prompt = `Suggest ONE original one-sentence idea for a children's bedtime story ("นิทาน"),
for kids age 3-8. It should center a small relatable emotional struggle (fear, shyness, jealousy,
feeling left out, etc.) that gets resolved through friendship, courage, or kindness — gentle and
warm, never scary or violent. Pick a fresh animal or character and situation, different from
generic "rabbit afraid of the dark" or "tortoise and the hare" ideas.

Write it in ${scriptLanguage}, as a single flowing sentence (not a title, not a list).

Return ONLY a raw JSON object (no markdown fences): { "idea": "..." }`;

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const parsed = parseJsonResponse(msg);
  return parsed.idea || "";
}

// Plans a whole story before any Series/Character/Episode exists: given a one-line idea, drafts
// the show identity, splits the story into short episodes sized to a target runtime, and proposes
// ONLY the characters the story actually needs. Deliberately asked to keep the cast small — every
// extra character is a whole locked sprite set (5-10 generated images) plus its own voice, and
// reusing one character across episodes is both cheaper and more visually consistent than
// inventing a new one per scene. Nothing is persisted here; the caller (POST /outline) just
// returns this draft for the user to review/edit before committing it via POST /outline/commit.
async function generateStoryOutline({ idea, voiceLocale = "en-US", targetEpisodeMinutes = 5, episodeCount = null }) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const scriptLanguage = SCRIPT_LANGUAGE_BY_LOCALE[voiceLocale] || DEFAULT_SCRIPT_LANGUAGE;
  const targetWords = Math.round(targetEpisodeMinutes * WORDS_PER_MINUTE);
  const episodeCountInstruction = episodeCount
    ? `Split the story into EXACTLY ${episodeCount} episodes — this is a hard requirement, not a suggestion.`
    : `Split the story into as many episodes as it naturally needs to tell it well at that length, not one arbitrary number.`;

  const prompt = `You are a children's story planner and show creator, writing a "นิทาน"
(bedtime/children's story) as a narrated motion-comic video series for kids.

The creator's idea: ${idea}

Plan the WHOLE story before any single episode gets written. Decide:

1. A show identity: title, one-paragraph premise, genre, tone (kid-appropriate — warm, gentle,
   age 3-8 friendly, no scary or violent content), and a short art-style description for a
   consistent illustrated look. This MUST read as a kids' animated cartoon (like a children's TV
   cartoon show), never photoreal, painterly, or a soft storybook/picture-book look — e.g. "kids'
   animated cartoon style, bold thick outlines, flat bright saturated colors, rounded friendly
   shapes".
2. How many episodes the story needs and what happens in each one, in story order. Each episode
   should be a self-contained chunk of the overall arc, roughly ${targetWords} spoken words long
   (about ${targetEpisodeMinutes} minutes of narration at natural pace). ${episodeCountInstruction}
   Give each episode a short title and a 1-3 sentence premise of what happens in it.
3. The cast: list ONLY the characters who actually appear with a real role somewhere in the story
   — do not invent side characters "for flavor". A character only earns a spot if they have real
   dialogue and an emotional beat in at least one episode. Prefer reusing one character across
   multiple episodes over introducing a new one for a single scene. For each character give: a
   short name, a locked visual description specific enough to draw the exact same way every time
   (species/type, age, build, colors, one or two distinctive features — no vague adjectives), their
   role in the story in one short phrase, and "gender": "male" or "female" (used to pick a
   matching narration voice).

Write the show title, episode titles/premises, and character names/descriptions/roles in
${scriptLanguage}, regardless of what language the idea above was typed in.

Return ONLY a raw JSON object (no markdown fences) in exactly this shape:
{
  "title": "show title",
  "premise": "one-paragraph pitch for the whole series",
  "genre": "short genre label",
  "tone": "short tone description",
  "artStyle": "art style description",
  "episodes": [
    { "title": "episode title", "premise": "1-3 sentences describing what happens in this episode" }
  ],
  "characters": [
    { "name": "character name", "description": "locked visual description", "role": "their role in the story, one short phrase", "gender": "male or female" }
  ]
}`;

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const parsed = parseJsonResponse(msg);
  const voicePool = CHARACTER_VOICES_BY_LOCALE[voiceLocale] || DEFAULT_CHARACTER_VOICES;

  // The model occasionally lists the same character twice (e.g. once as the protagonist, again
  // for a later beat) — nothing downstream dedupes by name, so an unfiltered list would turn into
  // two separate Character docs on commit. Keep only the first occurrence of each name.
  const seenNames = new Set();
  const characters = (parsed.characters || [])
    .map((c) => ({
      name: c.name || "Character",
      description: c.description || "",
      role: c.role || "",
      voiceName: c.gender === "female" ? voicePool.female : voicePool.male,
    }))
    .filter((c) => {
      const key = c.name.trim().toLowerCase();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });

  const episodes = (parsed.episodes || []).map((e, i) => ({
    episodeNumber: i + 1,
    title: e.title || `Episode ${i + 1}`,
    premise: e.premise || "",
  }));

  return {
    title: parsed.title || idea.slice(0, 60),
    premise: parsed.premise || idea,
    genre: parsed.genre || "",
    tone: parsed.tone || "",
    artStyle: parsed.artStyle || "",
    voiceLocale,
    targetEpisodeMinutes,
    episodes,
    characters,
  };
}

module.exports = { generateScript, summarizeEpisode, generateYoutubeMetadata, generateStoryOutline, suggestStoryIdea, EXPRESSIONS, CAMERA_MOVES };
