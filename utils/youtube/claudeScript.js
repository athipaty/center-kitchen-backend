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

const EXPRESSIONS = ["neutral", "happy", "sad", "surprised", "action"];
const CAMERA_MOVES = ["pan-left", "pan-right", "zoom-in", "zoom-out", "static"];

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

Write a short episode as 3-5 scenes. Each scene has a background description, which characters
are on screen, and a short sequence of dialogue/narration lines. Keep total dialogue brief enough
for a short video (roughly 4-8 lines total across all scenes). A line with no character speaking
(pure narration) is allowed — use character "Narrator" for those.

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
    max_tokens: 4096,
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

module.exports = { generateScript, summarizeEpisode, EXPRESSIONS, CAMERA_MOVES };
