const axios = require("axios");

// Free, keyless image generation — https://image.pollinations.ai/prompt/<encoded prompt>.
// No SLA and an anonymous-tier rate limit (~1 request/15s), which is fine here since every
// caller in the render pipeline already generates images in a sequential loop (one sprite/scene
// at a time), never in parallel — see jobs/youtubeEpisodeScheduler.js.
async function generateImage(prompt, { width = 1024, height = 1024, seed = null, model = "flux" } = {}) {
  const params = new URLSearchParams({ width: String(width), height: String(height), model, nologo: "true" });
  if (seed != null) params.set("seed", String(seed));
  if (process.env.POLLINATIONS_TOKEN) params.set("token", process.env.POLLINATIONS_TOKEN);

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;
  const { data } = await axios.get(url, { responseType: "arraybuffer", timeout: 60000 });
  return Buffer.from(data);
}

module.exports = { generateImage };
