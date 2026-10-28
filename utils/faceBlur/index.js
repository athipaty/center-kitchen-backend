// Blurs faces in spot photos before they're stored (Smoke Finder privacy rule:
// no identifiable people). Faces are found with UltraFace (version-RFB-640.onnx
// from the ONNX model zoo; Ultra-Light-Fast-Generic-Face-Detector-1MB by Linzaer,
// MIT license) run by onnxruntime-node. It also finds faces looking sideways
// or tilted, which a lighter detector missed in a real upload.
const path = require("path");
const sharp = require("sharp");

const MAX_SIDE = 1200; // stored photos are at most 1200 px
const MODEL_W = 640;
const MODEL_H = 480;
const MIN_SCORE = 0.6; // real faces scored 1.00 in testing
const NMS_IOU = 0.3;
const PADDING = 1.25; // blur a bit beyond the detected face: hair, ears, chin

// Loaded on the first photo, so the backend doesn't hold it in memory otherwise.
let sessionPromise = null;
function session() {
  sessionPromise ??= (async () => {
    const ort = require("onnxruntime-node");
    const s = await ort.InferenceSession.create(path.join(__dirname, "ultraface-RFB-640.onnx"), { logSeverityLevel: 3 });
    return { ort, s };
  })().catch((err) => {
    sessionPromise = null; // try again on the next photo
    throw err;
  });
  return sessionPromise;
}

function nonMaxSuppression(boxes) {
  boxes.sort((a, b) => b.score - a.score);
  const area = (b) => (b.x2 - b.x1) * (b.y2 - b.y1);
  const kept = [];
  for (const b of boxes) {
    const overlaps = kept.some((k) => {
      const ix = Math.max(0, Math.min(b.x2, k.x2) - Math.max(b.x1, k.x1));
      const iy = Math.max(0, Math.min(b.y2, k.y2) - Math.max(b.y1, k.y1));
      return (ix * iy) / (area(b) + area(k) - ix * iy) >= NMS_IOU;
    });
    if (!overlaps) kept.push(b);
  }
  return kept;
}

// Faces in an RGB image as boxes { left, top, width, height } in pixels.
async function findFaces(rgb, width, height) {
  const { ort, s } = await session().catch((err) => {
    throw Object.assign(new Error(`face finder unavailable: ${err.message}`), { faceFinder: true });
  });
  const small = await sharp(rgb, { raw: { width, height, channels: 3 } }).resize(MODEL_W, MODEL_H, { fit: "fill" }).raw().toBuffer();
  const plane = MODEL_W * MODEL_H;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) for (let ch = 0; ch < 3; ch++) input[ch * plane + i] = (small[i * 3 + ch] - 127) / 128;
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, MODEL_H, MODEL_W]) });
  const scores = out.scores.data;
  const boxes = out.boxes.data; // corners, 0-1 of the image
  const found = [];
  for (let i = 0; i < scores.length / 2; i++) {
    const score = scores[i * 2 + 1];
    if (score > MIN_SCORE) found.push({ score, x1: boxes[i * 4] * width, y1: boxes[i * 4 + 1] * height, x2: boxes[i * 4 + 2] * width, y2: boxes[i * 4 + 3] * height });
  }
  return nonMaxSuppression(found)
    .map((f) => {
      const w = (f.x2 - f.x1) * PADDING;
      const h = (f.y2 - f.y1) * PADDING;
      const left = Math.max(0, Math.round((f.x1 + f.x2) / 2 - w / 2));
      const top = Math.max(0, Math.round((f.y1 + f.y2) / 2 - h / 2));
      return { left, top, width: Math.min(Math.round(w), width - left), height: Math.min(Math.round(h), height - top) };
    })
    .filter((b) => b.width > 4 && b.height > 4);
}

// A strongly pixelated and blurred copy of one area, so the face can't be recovered.
async function obscure(rgb, info, box) {
  const area = sharp(rgb, { raw: info }).extract(box);
  const blocks = Math.max(4, Math.round(Math.min(box.width, box.height) / 12));
  const tiny = await area.resize(blocks, blocks, { fit: "fill" }).raw().toBuffer();
  return sharp(tiny, { raw: { width: blocks, height: blocks, channels: 3 } })
    .resize(box.width, box.height, { fit: "fill", kernel: "nearest" })
    .blur(Math.max(2, box.width / 20))
    .png()
    .toBuffer();
}

// Rotated, resized to at most 1200 px, EXIF removed, faces blurred, as WebP.
// Resolves { image, faces } where faces is how many were blurred.
async function toSafeWebp(input) {
  const { data: rgb, info } = await sharp(input)
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: 3 };
  const faces = await findFaces(rgb, info.width, info.height);
  const overlays = await Promise.all(faces.map(async (box) => ({ input: await obscure(rgb, raw, box), left: box.left, top: box.top })));
  const image = await sharp(rgb, { raw }).composite(overlays).webp({ quality: 80 }).toBuffer();
  return { image, faces: faces.length };
}

// For a health check: loads the face finder and runs it on a blank image.
async function selfTest() {
  const started = Date.now();
  const blank = Buffer.alloc(64 * 48 * 3, 128);
  const faces = await findFaces(blank, 64, 48);
  return { ok: true, faces: faces.length, ms: Date.now() - started };
}

module.exports = { toSafeWebp, findFaces, selfTest };
