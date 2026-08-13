import { AbsoluteFill, Audio, Img, Sequence, useVideoConfig } from "remotion";
import type { SceneProps } from "./types";

const msToFrames = (ms: number, fps: number) => Math.max(1, Math.round((ms / 1000) * fps));

// A scene is a static full-frame illustration — no Ken Burns pan/zoom, no per-line portrait or
// caption overlay. Motion between scenes comes from the page-flip transition (PageFlip.tsx) at the
// composition level, not from anything happening within a single scene. The per-line <Audio>
// Sequence loop is kept unchanged from the old per-line-sprite system — it's still what drives
// total scene duration and narration sync, it just no longer renders anything visual per line.
export const Scene: React.FC<SceneProps & { durationInFrames: number }> = ({
  imageUrl,
  dialogue,
}) => {
  const { fps } = useVideoConfig();
  let cursor = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Img src={imageUrl} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
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
