// Blurs faces in spot photos before they're stored (Smoke Finder privacy rule:
// no identifiable people). Uses the small pico face detector (pico.js, MIT), so
// nothing heavy is installed. It finds faces looking roughly at the camera;
// faces turned sideways or very small can be missed, which is why photo reports
// and moderation stay in place.
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const pico = require("./pico");

const MAX_SIDE = 1200; // stored photos are at most 1200 px
const MIN_FACE_PX = 24; // smaller faces aren't recognisable at this size anyway
const SCORE_MIN = 10; // real faces scored 22+ in testing, false matches (clothes, textures) 5-8
const PADDING = 1.6; // blur a bit beyond the detected face: hair, ears, chin
// The detector only finds upright faces, so it also looks at the photo turned
// both ways: a tilted head in a casual photo is upright in one of them.
const ANGLES = [0, -25, 25];

let classifyRegion = null;
function detector() {
  if (!classifyRegion) {
    const bytes = new Int8Array(fs.readFileSync(path.join(__dirname, "facefinder")));
    classifyRegion = pico.unpack_cascade(bytes);
  }
  return classifyRegion;
}

// Face centres and sizes [row, col, size] in one grayscale image.
function detect(gray, width, height) {
  const dets = pico.run_cascade(
    { pixels: gray, nrows: height, ncols: width, ldim: width },
    detector(),
    { shiftfactor: 0.1, minsize: MIN_FACE_PX, maxsize: Math.min(width, height), scalefactor: 1.1 }
  );
  return pico.cluster_detections(dets, 0.2).filter(([, , , q]) => q > SCORE_MIN);
}

// Faces in an RGB image as boxes { left, top, width, height } in pixels.
async function findFaces(rgb, width, height) {
  const found = [];
  for (const angle of ANGLES) {
    const { data, info } = await sharp(rgb, { raw: { width, height, channels: 3 } })
      .rotate(angle, { background: "#808080" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Map each centre back from the turned image: rotate by -angle around the centre.
    const rad = (-angle * Math.PI) / 180;
    const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
    for (const [r, c, s, q] of detect(data, info.width, info.height)) {
      const dx = c - info.width / 2;
      const dy = r - info.height / 2;
      found.push([height / 2 + dx * sin + dy * cos, width / 2 + dx * cos - dy * sin, s, q]);
    }
  }
  // The same face found at two angles becomes one.
  return pico
    .cluster_detections(found, 0.3)
    .map(([r, c, s]) => {
      const size = Math.round(s * PADDING);
      const left = Math.max(0, Math.round(c - size / 2));
      const top = Math.max(0, Math.round(r - size / 2));
      return { left, top, width: Math.min(size, width - left), height: Math.min(size, height - top) };
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

module.exports = { toSafeWebp, findFaces };
