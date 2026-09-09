const axios = require("axios");

// Kling 2.5 Turbo Pro (fal.ai) — image-to-video: takes a scene's already-generated illustration
// plus a motion prompt and returns a short animated clip (real character movement) instead of
// Remotion's own CSS pan/zoom. Real, meaningfully higher cost than image generation (~$0.07/sec,
// so $0.35-$0.70 per clip) unlike a scene image, so this is opt-in per scene, triggered only from
// the review panel's "Animate this scene" button (see routes/youtube/index.js's POST
// /episodes/:id/scenes/:order/animate) — never generated automatically alongside the rest of the
// episode.
const ENDPOINT = "https://fal.run/fal-ai/kling-video/v2.5-turbo/pro/image-to-video";

// Kling only accepts these two fixed clip lengths, not an arbitrary duration matching a scene's
// actual narration length — round up to the nearest one it supports; Scene.tsx loops the clip to
// cover any narration time left over past the clip's own length.
const ALLOWED_DURATIONS = [5, 10];
function nearestAllowedDuration(seconds) {
  return ALLOWED_DURATIONS.find((d) => d >= seconds) ?? ALLOWED_DURATIONS[ALLOWED_DURATIONS.length - 1];
}

async function generateSceneVideo(imageUrl, prompt, targetDurationSec) {
  const duration = nearestAllowedDuration(targetDurationSec);
  let data;
  try {
    ({ data } = await axios.post(ENDPOINT, {
      prompt,
      image_url: imageUrl,
      duration: String(duration),
    }, {
      headers: {
        Authorization: `Key ${process.env.FAL_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 300000, // video generation runs well past even FLUX.2's own observed 60-150s+ calls
    }));
  } catch (err) {
    // Same reasoning as fal.js's callFal — axios's own message can't tell a bad parameter apart
    // from a content-policy block, so surface fal.ai's actual response body instead of guessing.
    const detail = err.response?.data?.detail;
    const reason = typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : err.message;
    console.error(`fal.ai kling-video failed (${err.response?.status ?? "?"}):`, reason);
    throw new Error(`fal.ai kling-video ${err.response?.status ?? ""}: ${reason}`.trim());
  }
  const url = data?.video?.url;
  if (!url) throw new Error("fal.ai kling-video returned no video");
  const { data: videoData } = await axios.get(url, { responseType: "arraybuffer", timeout: 120000 });
  return { buffer: Buffer.from(videoData), durationSec: duration };
}

module.exports = { generateSceneVideo };
