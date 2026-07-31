const axios = require("axios");

// Free, keyless image generation — https://image.pollinations.ai/prompt/<encoded prompt>.
// No SLA and an anonymous-tier rate limit (~1 request/15s). This used to be safe on the
// assumption that only one episode's pipeline ever ran at a time, each pacing its own sequential
// loop with a sleep between calls (see jobs/youtubeEpisodeScheduler.js) — but several episodes
// can now be in flight concurrently (e.g. the outline-commit flow creates many at once, and
// episodes sharing a character can both try to generate its sprites around the same time), and
// each independently pacing itself doesn't add up to a shared global pace. A concrete symptom:
// two episodes' sprite generation racing on the same character produced duplicate sprite entries
// and 429s from Pollinations.
//
// Throttling now lives here instead, as one process-wide serialized queue every caller shares —
// however many callers are "concurrently" generating, actual HTTP calls to Pollinations always go
// out one at a time, at least RATE_LIMIT_MS apart, regardless of which episode/character/loop
// asked for it. Set above the documented ~15s floor as extra margin — the actual 429 that exposed
// this was very likely just the missing serialization above, but Pollinations is an unauthenticated
// free tier with no SLA and no guarantee its real limit doesn't vary, so a bit of slack is cheap
// insurance against a slower, flakier failure mode than "generation takes longer."
const RATE_LIMIT_MS = 20000;
let queue = Promise.resolve();

function throttled(fn) {
  const run = queue.then(async () => {
    const result = await fn();
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    return result;
  });
  // The queue chain itself must never reject, or every call behind a failed one would fail too —
  // each `run` promise still rejects normally for whoever awaited generateImage() directly.
  queue = run.catch(() => {});
  return run;
}

async function generateImage(prompt, { width = 1024, height = 1024, seed = null, model = "flux" } = {}) {
  return throttled(async () => {
    const params = new URLSearchParams({ width: String(width), height: String(height), model, nologo: "true" });
    if (seed != null) params.set("seed", String(seed));
    if (process.env.POLLINATIONS_TOKEN) params.set("token", process.env.POLLINATIONS_TOKEN);

    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;
    const { data } = await axios.get(url, { responseType: "arraybuffer", timeout: 60000 });
    return Buffer.from(data);
  });
}

module.exports = { generateImage };
