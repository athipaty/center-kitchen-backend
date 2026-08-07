import { AbsoluteFill, Audio, Img, Sequence, useVideoConfig } from "remotion";
import type { SceneProps } from "./types";

const msToFrames = (ms: number, fps: number) => Math.max(1, Math.round((ms / 1000) * fps));

// Width of the book-spine divider drawn between the two pages, in pixels at the composition's
// native 1280x720 — a plain CSS gradient, not something the image model needs to draw itself.
const SPINE_WIDTH = 8;

// A scene is a static two-page storybook spread — no Ken Burns pan/zoom, no per-line portrait or
// caption overlay. Motion between scenes comes from the page-flip transition (PageFlip.tsx) at the
// composition level, not from anything happening within a single scene. The per-line <Audio>
// Sequence loop is kept unchanged from the old per-line-sprite system — it's still what drives
// total scene duration and narration sync, it just no longer renders anything visual per line.
export const Scene: React.FC<SceneProps & { durationInFrames: number }> = ({
  leftPageUrl,
  rightPageUrl,
  dialogue,
}) => {
  const { fps } = useVideoConfig();
  let cursor = 0;

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ right: "50%" }}>
        <Img src={leftPageUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ left: "50%" }}>
        <Img src={rightPageUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: "50%",
          width: SPINE_WIDTH,
          marginLeft: -SPINE_WIDTH / 2,
          background: "linear-gradient(to right, rgba(0,0,0,0.35), rgba(0,0,0,0.05), rgba(0,0,0,0.35))",
          zIndex: 2,
        }}
      />
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
