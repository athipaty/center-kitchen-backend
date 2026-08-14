import { AbsoluteFill, Audio, Img, Sequence, useVideoConfig } from "remotion";
import type { SceneProps } from "./types";

const msToFrames = (ms: number, fps: number) => Math.max(1, Math.round((ms / 1000) * fps));

// A scene is a static full-frame illustration — no Ken Burns pan/zoom, no per-line portrait
// overlay. Motion between scenes comes from the page-flip transition (PageFlip.tsx) at the
// composition level, not from anything happening within a single scene. The per-line <Audio>
// Sequence loop is kept unchanged from the old per-line-sprite system — it's still what drives
// total scene duration and narration sync; a burned-in subtitle now rides the same from/duration
// frame math so captions are always in sync with the line currently playing.
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
