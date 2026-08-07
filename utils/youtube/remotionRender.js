const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REMOTION_DIR = path.resolve(__dirname, "../../remotion");

// Renders one episode by shelling out to remotion/render.js as a subprocess — kept isolated from
// the Express process because Remotion's toolchain (webpack, React 19, TypeScript) is a separate
// world from this plain CommonJS app. Writes episodeProps to a temp JSON file (the CLI script
// reads it by path rather than via stdin/argv, since prop payloads can be large), renders to a
// temp MP4, and returns that MP4's buffer for the caller to upload — the temp files are cleaned
// up here so the job pipeline doesn't need to know about them.
async function renderEpisodeToBuffer(episodeProps, episodeId) {
  const tmpDir = os.tmpdir();
  const propsPath = path.join(tmpDir, `youtube-episode-${episodeId}-props.json`);
  const outPath = path.join(tmpDir, `youtube-episode-${episodeId}-out.mp4`);

  fs.writeFileSync(propsPath, JSON.stringify(episodeProps));

  await new Promise((resolve, reject) => {
    execFile(
      "node",
      [path.join(REMOTION_DIR, "render.js"), propsPath, outPath],
      // Episodes are scripted to run 3+ minutes minimum (see claudeScript.js's word-count floor),
      // which on Render's single-core instance can take well over 10 minutes of wall-clock time to
      // render frame-by-frame through headless Chrome — a 9858-frame (5.5min) episode was observed
      // getting killed mid-render at the old 10-minute cap. This runs off the scheduler's background
      // tick, not an HTTP request, so a generous ceiling here doesn't risk a client-facing timeout.
      { cwd: REMOTION_DIR, maxBuffer: 50 * 1024 * 1024, timeout: 30 * 60 * 1000 },
      (err, stdout, stderr) => {
        if (err) {
          // err.message alone doesn't say *why* it died (hit the timeout above vs. OOM-killed by
          // the host vs. an actual crash) — surface signal/killed so a recurrence is diagnosable
          // instead of just another truncated "rendering N frames..." log.
          const cause = err.killed ? ` (killed, signal=${err.signal})` : err.signal ? ` (signal=${err.signal})` : "";
          return reject(new Error(`remotion render failed${cause}: ${err.message}\n${stderr || stdout}`));
        }
        resolve();
      }
    );
  });

  const buffer = fs.readFileSync(outPath);
  fs.unlink(propsPath, () => {});
  fs.unlink(outPath, () => {});
  return buffer;
}

module.exports = { renderEpisodeToBuffer };
