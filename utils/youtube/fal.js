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

module.exports = { generateImageFlux, generateCharacterImage };
