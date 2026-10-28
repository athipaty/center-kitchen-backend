/* The face detector used by faceBlur.js: unpack_cascade, run_cascade and
   cluster_detections from pico.js by Nenad Markus (https://github.com/nenadmarkus/picojs),
   released under the MIT license; see LICENSE-pico in this folder. The face
   cascade "facefinder" comes from https://github.com/nenadmarkus/pico (MIT,
   Copyright (c) 2013 Nenad Markus). Unchanged apart from CommonJS exports. */

function unpack_cascade(bytes) {
  const dview = new DataView(new ArrayBuffer(4));
  // skip the first 8 bytes (cascade version and training data)
  let p = 8;
  dview.setUint8(0, bytes[p + 0]), dview.setUint8(1, bytes[p + 1]), dview.setUint8(2, bytes[p + 2]), dview.setUint8(3, bytes[p + 3]);
  const tdepth = dview.getInt32(0, true);
  p = p + 4;
  dview.setUint8(0, bytes[p + 0]), dview.setUint8(1, bytes[p + 1]), dview.setUint8(2, bytes[p + 2]), dview.setUint8(3, bytes[p + 3]);
  const ntrees = dview.getInt32(0, true);
  p = p + 4;
  const tcodes_ls = [];
  const tpreds_ls = [];
  const thresh_ls = [];
  for (let t = 0; t < ntrees; ++t) {
    Array.prototype.push.apply(tcodes_ls, [0, 0, 0, 0]);
    Array.prototype.push.apply(tcodes_ls, bytes.slice(p, p + 4 * Math.pow(2, tdepth) - 4));
    p = p + 4 * Math.pow(2, tdepth) - 4;
    for (let i = 0; i < Math.pow(2, tdepth); ++i) {
      dview.setUint8(0, bytes[p + 0]), dview.setUint8(1, bytes[p + 1]), dview.setUint8(2, bytes[p + 2]), dview.setUint8(3, bytes[p + 3]);
      tpreds_ls.push(dview.getFloat32(0, true));
      p = p + 4;
    }
    dview.setUint8(0, bytes[p + 0]), dview.setUint8(1, bytes[p + 1]), dview.setUint8(2, bytes[p + 2]), dview.setUint8(3, bytes[p + 3]);
    thresh_ls.push(dview.getFloat32(0, true));
    p = p + 4;
  }
  const tcodes = new Int8Array(tcodes_ls);
  const tpreds = new Float32Array(tpreds_ls);
  const thresh = new Float32Array(thresh_ls);

  function classify_region(r, c, s, pixels, ldim) {
    r = 256 * r;
    c = 256 * c;
    let root = 0;
    let o = 0.0;
    const pow2tdepth = Math.pow(2, tdepth) >> 0;
    for (let i = 0; i < ntrees; ++i) {
      let idx = 1;
      for (let j = 0; j < tdepth; ++j)
        idx =
          2 * idx +
          (pixels[((r + tcodes[root + 4 * idx + 0] * s) >> 8) * ldim + ((c + tcodes[root + 4 * idx + 1] * s) >> 8)] <=
            pixels[((r + tcodes[root + 4 * idx + 2] * s) >> 8) * ldim + ((c + tcodes[root + 4 * idx + 3] * s) >> 8)]);
      o = o + tpreds[pow2tdepth * i + idx - pow2tdepth];
      if (o <= thresh[i]) return -1;
      root += 4 * pow2tdepth;
    }
    return o - thresh[ntrees - 1];
  }
  return classify_region;
}

function run_cascade(image, classify_region, params) {
  const { pixels, nrows, ncols, ldim } = image;
  const { shiftfactor, minsize, maxsize, scalefactor } = params;
  let scale = minsize;
  const detections = [];
  while (scale <= maxsize) {
    const step = Math.max(shiftfactor * scale, 1) >> 0;
    const offset = (scale / 2 + 1) >> 0;
    for (let r = offset; r <= nrows - offset; r += step)
      for (let c = offset; c <= ncols - offset; c += step) {
        const q = classify_region(r, c, scale, pixels, ldim);
        if (q > 0.0) detections.push([r, c, scale, q]);
      }
    scale = scale * scalefactor;
  }
  return detections;
}

function cluster_detections(dets, iouthreshold) {
  dets = dets.sort((a, b) => b[3] - a[3]);
  function calculate_iou(det1, det2) {
    const r1 = det1[0], c1 = det1[1], s1 = det1[2];
    const r2 = det2[0], c2 = det2[1], s2 = det2[2];
    const overr = Math.max(0, Math.min(r1 + s1 / 2, r2 + s2 / 2) - Math.max(r1 - s1 / 2, r2 - s2 / 2));
    const overc = Math.max(0, Math.min(c1 + s1 / 2, c2 + s2 / 2) - Math.max(c1 - s1 / 2, c2 - s2 / 2));
    return (overr * overc) / (s1 * s1 + s2 * s2 - overr * overc);
  }
  const assignments = new Array(dets.length).fill(0);
  const clusters = [];
  for (let i = 0; i < dets.length; ++i) {
    if (assignments[i] == 0) {
      let r = 0.0, c = 0.0, s = 0.0, q = 0.0, n = 0;
      for (let j = i; j < dets.length; ++j)
        if (calculate_iou(dets[i], dets[j]) > iouthreshold) {
          assignments[j] = 1;
          r = r + dets[j][0];
          c = c + dets[j][1];
          s = s + dets[j][2];
          q = q + dets[j][3];
          n = n + 1;
        }
      clusters.push([r / n, c / n, s / n, q]);
    }
  }
  return clusters;
}

module.exports = { unpack_cascade, run_cascade, cluster_detections };
