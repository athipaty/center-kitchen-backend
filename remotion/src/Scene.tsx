import { AbsoluteFill, Audio, Img, interpolate, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
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

// A scene is a full-frame illustration with a slow Ken Burns pan/zoom — no per-line portrait
// overlay. Motion between scenes additionally comes from the page-flip transition (PageFlip.tsx)
// at the composition level. The per-line <Audio> Sequence loop is kept unchanged from the old
// per-line-sprite system — it's still what drives total scene duration and narration sync; a
// burned-in subtitle rides the same from/duration frame math so captions stay in sync with the
// line currently playing.
export const Scene: React.FC<SceneProps & { durationInFrames: number; index: number }> = ({
  imageUrl,
  dialogue,
  durationInFrames,
  index,
}) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  let cursor = 0;

  const pattern = KEN_BURNS_PATTERNS[index % KEN_BURNS_PATTERNS.length];
  const clampOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const scale = interpolate(frame, [0, durationInFrames], [pattern.scaleFrom, pattern.scaleTo], clampOpts);
  const x = interpolate(frame, [0, durationInFrames], [pattern.xFrom, pattern.xTo], clampOpts);
  const y = interpolate(frame, [0, durationInFrames], [pattern.yFrom, pattern.yTo], clampOpts);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
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
      {dialogue.map((line, i) => {
        const lineFrames = msToFrames(line.durationMs, fps);
        const from = cursor;
        cursor += lineFrames;
        return (
          <Sequence key={i} from={from} durationInFrames={lineFrames} layout="none">
            <Audio src={line.audioUrl} />
            {line.text && (
              <AbsoluteFill
                style={{ justifyContent: "flex-end", alignItems: "center", padding: "0 60px 48px" }}
              >
                <div
                  style={{
                    maxWidth: "85%",
                    padding: "10px 24px",
                    borderRadius: 12,
                    backgroundColor: "rgba(0,0,0,0.65)",
                    color: "#fff",
                    fontFamily: "'Noto Sans Thai', 'Noto Sans', sans-serif",
                    fontSize: 32,
                    fontWeight: 700,
                    textAlign: "center",
                    lineHeight: 1.35,
                    textShadow: "0 2px 4px rgba(0,0,0,0.6)",
                  }}
                >
                  {line.text}
                </div>
              </AbsoluteFill>
            )}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
