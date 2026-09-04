const axios = require("axios");

// Google's Gemini 2.5 Flash Image ("Nano Banana") — free tier: 500 images/day, ~10 requests/min,
// no credit card required. Multimodal: a single generateContent call takes a text prompt plus
// zero or more reference images and returns a generated/edited image, which is what makes
// multi-reference character consistency possible here for $0 instead of fal.ai FLUX.2's
// per-image cost (see git history for that prior iteration).
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The free tier's ~10 requests/min cap is easy to trip mid-episode now that stepImages generates
// one image per scene back-to-back (more scenes per episode since the scene-count fix) plus a
// reference portrait per new character — all in one sequential run. Rather than failing the whole
// episode on the first 429, back off and retry: Gemini's own Retry-After header (when present)
// tells us exactly how long the current minute-window has left; otherwise fall back to increasing
// delays. Any other error (bad prompt, no image returned, etc.) is not retried — it won't succeed
// on a second try.
const MAX_RETRIES = 5;

async function callGemini(parts, aspectRatio) {
  for (let attempt = 0; ; attempt++) {
    try {
      const { data } = await axios.post(ENDPOINT, {
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["Image"],
          imageConfig: { aspectRatio },
        },
      }, {
        headers: {
          "x-goog-api-key": process.env.GEMINI_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 120000,
      });
      const responseParts = data?.candidates?.[0]?.content?.parts || [];
      const imagePart = responseParts.find((p) => p.inlineData?.data);
      if (!imagePart) throw new Error("Gemini generateContent returned no image");
      return Buffer.from(imagePart.inlineData.data, "base64");
    } catch (err) {
      const status = err.response?.status;
      if (status !== 429 || attempt >= MAX_RETRIES) throw err;
      const retryAfterSec = Number(err.response.headers?.["retry-after"]);
      const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : 2 ** attempt * 5000; // 5s, 10s, 20s, 40s, 80s
      await sleep(delayMs);
    }
  }
}

// Fetches an existing image (a B2-hosted reference photo URL) and base64-encodes it into an
// inlineData part Gemini can take as multimodal input alongside the text prompt.
async function urlToInlinePart(url) {
  const { data, headers } = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  return {
    inlineData: {
      mimeType: headers["content-type"] || "image/jpeg",
      data: Buffer.from(data).toString("base64"),
    },
  };
}

// A character's single locked reference portrait — the identity anchor every scene referencing
// them gets conditioned on via generateSceneWithReferences below. Plain text-to-image, nothing to
// reference yet (this IS the reference).
async function generateCharacterReferenceImage(prompt) {
  return callGemini([{ text: prompt }], "1:1");
}

// A scene with no characters on screen (a pure establishing shot) — still routed through Gemini
// rather than a different model so every scene in an episode shares one consistent look, even
// the ones with nothing to keep consistent.
async function generateSceneImage(prompt) {
  return callGemini([{ text: prompt }], "16:9");
}

// One full scene illustration, conditioned on each on-screen character's reference photo so every
// character in the frame keeps the same face/colors/proportions as their locked reference instead
// of being reinvented from a text description alone each time — this is what actually solves
// character consistency across scenes/angles. Callers are expected to keep referenceImageUrls in
// the same order the prompt itself numbers them in ("Reference image 1 shows X...") so the model
// can bind each photo to the right name — see buildCastLine in youtubeEpisodeScheduler.js.
async function generateSceneWithReferences(prompt, referenceImageUrls) {
  const imageParts = await Promise.all(referenceImageUrls.map(urlToInlinePart));
  return callGemini([{ text: prompt }, ...imageParts], "16:9");
}

module.exports = { generateCharacterReferenceImage, generateSceneImage, generateSceneWithReferences };
