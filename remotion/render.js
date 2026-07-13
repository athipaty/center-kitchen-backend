// CLI entry invoked as a subprocess from ../utils/youtube/remotionRender.js — kept as a plain
// Node script (not part of the TS/webpack-bundled composition) since it just orchestrates the
// bundle+render, run once per episode.
//
// Usage: node render.js <propsJsonPath> <outMp4Path>
const path = require("path");
const { bundle } = require("@remotion/bundler");
const { renderMedia, selectComposition, openBrowser } = require("@remotion/renderer");

async function main() {
  const [, , propsPath, outPath] = process.argv;
  if (!propsPath || !outPath) {
    console.error("Usage: node render.js <propsJsonPath> <outMp4Path>");
    process.exit(1);
  }
  const inputProps = JSON.parse(require("fs").readFileSync(path.resolve(propsPath), "utf8"));

  console.log("render.js: bundling composition...");
  const serveUrl = await bundle({
    entryPoint: path.resolve(__dirname, "src/index.ts"),
    publicDir: path.resolve(__dirname, "public"), // not auto-detected when calling bundle() programmatically
  });

  // Reused across selectComposition + renderMedia so only one Chrome process is ever
  // launched per render (each launch has its own baseline memory cost, and on Render's
  // small instances two overlapping browsers was a real contributor to OOM crashes).
  // concurrency: 1 is explicit rather than left to Remotion's CPU-based auto-detection,
  // which reads the host's core count and can over-provision parallel render tabs on
  // containers with a fractional CPU quota — each extra tab is its own memory cost with
  // no real speedup on a 1-CPU instance.
  const browserInstance = await openBrowser("chrome");
  try {
    console.log("render.js: selecting composition...");
    const composition = await selectComposition({ serveUrl, id: "Episode", inputProps, puppeteerInstance: browserInstance });

    console.log(`render.js: rendering ${composition.durationInFrames} frames...`);
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: path.resolve(outPath),
      inputProps,
      puppeteerInstance: browserInstance,
      concurrency: 1,
    });
  } finally {
    await browserInstance.close({ silent: true });
  }

  console.log("render.js: done ->", outPath);
}

main().catch((err) => {
  console.error("render.js: FAILED:", err);
  process.exit(1);
});
