// CLI entry invoked as a subprocess from ../utils/youtube/remotionRender.js — kept as a plain
// Node script (not part of the TS/webpack-bundled composition) since it just orchestrates the
// bundle+render, run once per episode.
//
// Usage: node render.js <propsJsonPath> <outMp4Path>
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { bundle } = require("@remotion/bundler");
const { renderMedia, selectComposition, openBrowser } = require("@remotion/renderer");

// A single continuous browser session accumulates memory across every frame it renders with
// nothing ever freed until the whole render finishes — confirmed via Render's own memory
// metrics on a 9488-frame episode: climbed from ~300MB baseline to ~1.3GB and got OOM-killed
// mid-render, right as memory was still climbing. Rendering in bounded chunks, each with its
// own fresh browser instance, caps how much a single session can accumulate before it's closed
// and its memory released back to the OS.
const CHUNK_SIZE_FRAMES = Number(process.env.REMOTION_CHUNK_SIZE_FRAMES) || 1500;

async function renderChunk({ composition, serveUrl, inputProps, frameRange, outputLocation }) {
  const browserInstance = await openBrowser("chrome");
  try {
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation,
      inputProps,
      puppeteerInstance: browserInstance,
      concurrency: 1,
      frameRange,
    });
  } finally {
    await browserInstance.close({ silent: true });
  }
}

// ffmpeg's concat demuxer does a lossless stream copy (-c copy) rather than re-encoding, safe
// here because every chunk comes from the same renderMedia call shape (same codec/resolution/
// fps), so their streams are byte-compatible for concatenation.
async function concatChunks(chunkPaths, outPath) {
  const listPath = `${outPath}.concat.txt`;
  const listContents = chunkPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(listPath, listContents);
  try {
    await new Promise((resolve, reject) => {
      execFile(
        ffmpegPath,
        ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath],
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`ffmpeg concat failed: ${err.message}\n${stderr || stdout}`));
          resolve();
        }
      );
    });
  } finally {
    fs.unlink(listPath, () => {});
  }
}

async function main() {
  const [, , propsPath, outPath] = process.argv;
  if (!propsPath || !outPath) {
    console.error("Usage: node render.js <propsJsonPath> <outMp4Path>");
    process.exit(1);
  }
  const resolvedOutPath = path.resolve(outPath);
  const inputProps = JSON.parse(fs.readFileSync(path.resolve(propsPath), "utf8"));

  console.log("render.js: bundling composition...");
  const serveUrl = await bundle({
    entryPoint: path.resolve(__dirname, "src/index.ts"),
    publicDir: path.resolve(__dirname, "public"), // not auto-detected when calling bundle() programmatically
  });

  console.log("render.js: selecting composition...");
  let composition;
  {
    // Short-lived browser just to evaluate composition metadata (duration, fps, dimensions) —
    // closed immediately, never used for actual frame rendering.
    const probeBrowser = await openBrowser("chrome");
    try {
      composition = await selectComposition({ serveUrl, id: "Episode", inputProps, puppeteerInstance: probeBrowser });
    } finally {
      await probeBrowser.close({ silent: true });
    }
  }

  const totalFrames = composition.durationInFrames;
  const tmpDir = os.tmpdir();
  const tag = path.basename(outPath, path.extname(outPath));
  const chunkPaths = [];

  for (let start = 0; start < totalFrames; start += CHUNK_SIZE_FRAMES) {
    const end = Math.min(start + CHUNK_SIZE_FRAMES, totalFrames) - 1;
    const chunkIndex = chunkPaths.length;
    const chunkOut = path.join(tmpDir, `${tag}-chunk${chunkIndex}.mp4`);
    console.log(`render.js: rendering chunk ${chunkIndex} (frames ${start}-${end} of ${totalFrames})...`);
    await renderChunk({ composition, serveUrl, inputProps, frameRange: [start, end], outputLocation: chunkOut });
    chunkPaths.push(chunkOut);
  }

  if (chunkPaths.length === 1) {
    fs.renameSync(chunkPaths[0], resolvedOutPath);
  } else {
    console.log(`render.js: stitching ${chunkPaths.length} chunks together...`);
    await concatChunks(chunkPaths, resolvedOutPath);
    for (const p of chunkPaths) fs.unlink(p, () => {});
  }

  console.log("render.js: done ->", resolvedOutPath);
}

main().catch((err) => {
  console.error("render.js: FAILED:", err);
  process.exit(1);
});
