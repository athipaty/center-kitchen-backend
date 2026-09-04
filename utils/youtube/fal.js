const axios = require("axios");

// Verified directly against the live API (fal.ai's own docs pages kept 429-ing) — both endpoints
// return { images: [{ url, width, height, content_type }], seed, ... } on success.
async function callFal(model, body) {
  const { data } = await axios.post(`https://fal.run/${model}`, body, {
    headers: {
      Authorization: `Key ${process.env.FAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 240000, // observed real calls taking 60-150s+ despite sub-second reported "inference" time
  });
  const url = data?.images?.[0]?.url;
  if (!url) throw new Error(`fal.ai ${model} returned no image`);
  const { data: imgData } = await axios.get(url, { responseType: "arraybuffer", timeout: 60000 });
  return Buffer.from(imgData);
}

// Plain text-to-image. Used for a character's first/base sprite (nothing to reference yet) and
// for scene backgrounds, which don't need identity consistency.
async function generateImageFlux(prompt, { width = 1024, height = 1024, seed = null } = {}) {
  return callFal("fal-ai/flux/schnell", {
    prompt,
    image_size: { width, height },
    ...(seed != null ? { seed } : {}),
  });
}

// Image-to-image, reference-conditioned on referenceImageUrl — keeps the character's identity
// (face/colors/proportions) while applying a new prompt (pose/expression). Used for every sprite
// after a character's first/base one.
async function generateCharacterImage(prompt, referenceImageUrl, { seed = null } = {}) {
  return callFal("fal-ai/instant-character", {
    prompt,
    image_url: referenceImageUrl,
    ...(seed != null ? { seed } : {}),
  });
}

// FLUX.2 takes a fixed set of preset sizes (no free-form width/height like flux/schnell above) —
// landscape_16_9 is the closest match to the episode pipeline's 1600x900 scene composition;
// Remotion just scales whatever aspect-correct image comes back to fit its 1280x720 frame
// regardless of exact pixel count. square_hd suits a single-character bust portrait.
const SCENE_IMAGE_SIZE = "landscape_16_9";
const PORTRAIT_IMAGE_SIZE = "square_hd";

// A character's single locked reference portrait — the identity anchor every scene referencing
// them gets conditioned on via generateSceneWithReferences below. Plain text-to-image, nothing to
// reference yet (this IS the reference).
async function generateCharacterReferenceImage(prompt, { seed = null } = {}) {
  return callFal("fal-ai/flux-2-pro", {
    prompt,
    image_size: PORTRAIT_IMAGE_SIZE,
    ...(seed != null ? { seed } : {}),
  });
}

// A scene with no characters on screen (a pure establishing shot) — still routed through FLUX.2
// rather than a different/cheaper model so every scene in an episode shares one consistent
// look, even the ones with nothing to keep consistent.
async function generateSceneImage(prompt, { seed = null } = {}) {
  return callFal("fal-ai/flux-2-pro", {
    prompt,
    image_size: SCENE_IMAGE_SIZE,
    ...(seed != null ? { seed } : {}),
  });
}

// One full scene illustration, conditioned on up to 9 reference images (FLUX.2's own limit) so
// every character in the frame keeps the same face/colors/proportions as their locked reference
// portrait instead of being reinvented from a text description alone each time — this is what
// actually solves character consistency across scenes/angles, unlike a fresh text-to-image call
// per scene. Callers are expected to keep referenceImageUrls in the same order the prompt itself
// numbers them in ("Reference image 1 shows X...") so the model can bind each photo to the right
// name — see buildCastLine in youtubeEpisodeScheduler.js.
async function generateSceneWithReferences(prompt, referenceImageUrls, { seed = null } = {}) {
  return callFal("fal-ai/flux-2-pro/edit", {
    prompt,
    image_urls: referenceImageUrls.slice(0, 9),
    image_size: SCENE_IMAGE_SIZE,
    ...(seed != null ? { seed } : {}),
  });
}

module.exports = {
  generateImageFlux,
  generateCharacterImage,
  generateCharacterReferenceImage,
  generateSceneImage,
  generateSceneWithReferences,
};
