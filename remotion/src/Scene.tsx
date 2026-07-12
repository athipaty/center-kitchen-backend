import { AbsoluteFill, Audio, Img, Sequence, useVideoConfig } from "remotion";
import { KenBurnsImage } from "./KenBurnsImage";
import { CaptionOverlay } from "./CaptionOverlay";
import type { SceneProps } from "./types";

const msToFrames = (ms: number, fps: number) => Math.max(1, Math.round((ms / 1000) * fps));

export const Scene: React.FC<SceneProps & { durationInFrames: number }> = ({
  backgroundUrl,
  cameraMove,
  dialogue,
  durationInFrames,
}) => {
  const { fps } = useVideoConfig();
  let cursor = 0;

  return (
    <AbsoluteFill>
      <KenBurnsImage src={backgroundUrl} durationInFrames={durationInFrames} move={cameraMove} />
      {dialogue.map((line, i) => {
        const lineFrames = msToFrames(line.durationMs, fps);
        const from = cursor;
        cursor += lineFrames;
        return (
          <Sequence key={i} from={from} durationInFrames={lineFrames} layout="none">
            <Audio src={line.audioUrl} />
            {line.spriteUrl && (
              <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-end" }}>
                <Img
                  src={line.spriteUrl}
                  style={{ height: "70%", objectFit: "contain", marginBottom: "18%" }}
                />
              </AbsoluteFill>
            )}
            <CaptionOverlay text={line.text} speaker={line.speaker} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
