import { AbsoluteFill, Audio, Img, interpolate, Loop, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { SceneProps } from "./types";

const msToFrames = (ms: number, fps: number) => Math.max(1, Math.round((ms / 1000) * fps));

// Four alternating Ken Burns pan/zoom patterns, cycled by scene index (not random — Remotion
// renders must be deterministic, and a fixed cycle also guarantees consecutive scenes don't all
// drift the same direction). Percentages are CSS transform translate() values, which resolve
// against the (already 100%-of-frame) element's own box — kept small relative to each pattern's
// zoom headroom so a pan never uncovers the frame edge (see the cover object-fit below, which
// gives extra margin too by cropping instead of letterboxing).
const KEN_BURNS_PATTERNS = [
  { scaleFrom: 1, scaleTo: 1.12, xFrom: 0, xTo: -2, yFrom: 0, yTo: -2 },
  { scaleFrom: 1.12, scaleTo: 1, xFrom: 2, xTo: 0, yFrom: 1, yTo: 0 },
  { scaleFrom: 1, scaleTo: 1.12, xFrom: 0, xTo: 2, yFrom: 0, yTo: 1 },
  { scaleFrom: 1.12, scaleTo: 1, xFrom: -2, xTo: 0, yFrom: -1, yTo: 0 },
];

// A scene is a full-frame illustration with a slow Ken Burns pan/zoom by default — or, when
// videoUrl is set (an opt-in per-scene Kling image-to-video upgrade, see falVideo.js), a real
// animated clip instead, played plainly with no pan/zoom stacked on top (real motion plus a
// simulated camera move looks like double motion, not extra production value). No per-line
// portrait overlay, no burned-in captions (YouTube's own subtitle/CC feature covers that, and
// hardcoding text into the video just blocks the picture instead). Motion between scenes
// additionally comes from the page-flip transition (PageFlip.tsx) at the composition level. The
// per-line <Audio> Sequence loop is kept unchanged from the old per-line-sprite system — it's
// still what drives total scene duration and narration sync, for a video-backed scene too.
export const Scene: React.FC<SceneProps & { durationInFrames: number; index: number }> = ({
  imageUrl,
  videoUrl,
  videoDurationMs,
  dialogue,
  durationInFrames,
  index,
}) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  let cursor = 0;
  // Kling only generates fixed 5s/10s clips, rarely an exact match to this scene's actual
  // narration length — <Loop> needs the clip's own length in frames to loop it seamlessly instead
  // of either cutting off abruptly or freezing on the last frame. Falls back to the scene's full
  // duration (i.e. no looping) if videoDurationMs is ever missing, which shouldn't happen for a
  // clip that made it this far but is a safe no-op if it does.
  const clipFrames = videoDurationMs ? msToFrames(videoDurationMs, fps) : durationInFrames;

  const pattern = KEN_BURNS_PATTERNS[index % KEN_BURNS_PATTERNS.length];
  const clampOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const scale = interpolate(frame, [0, durationInFrames], [pattern.scaleFrom, pattern.scaleTo], clampOpts);
  const x = interpolate(frame, [0, durationInFrames], [pattern.xFrom, pattern.xTo], clampOpts);
  const y = interpolate(frame, [0, durationInFrames], [pattern.yFrom, pattern.yTo], clampOpts);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {videoUrl ? (
        <Loop durationInFrames={clipFrames}>
          <OffthreadVideo
            src={videoUrl}
            muted
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </Loop>
      ) : (
        <Img
          src={imageUrl}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: `scale(${scale}) translate(${x}%, ${y}%)`,
            transformOrigin: "center center",
          }}
        />
      )}
      {dialogue.map((line, i) => {
        const lineFrames = msToFrames(line.durationMs, fps);
        const from = cursor;
        cursor += lineFrames;
        return (
          <Sequence key={i} from={from} durationInFrames={lineFrames} layout="none">
            <Audio src={line.audioUrl} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
