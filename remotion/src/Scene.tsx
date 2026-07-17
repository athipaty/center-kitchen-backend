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
            {line.characters.length > 0 && (
              // One portrait per on-screen character, spread evenly left-to-right across the top
              // of the frame (not stacked center-bottom) so two characters sharing a scene don't
              // just replace each other in the same spot as the speaker changes. Kept near the top
              // and slightly see-through so the background stays visible and the bottom-anchored
              // CaptionOverlay has clear room.
              <AbsoluteFill style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-evenly", paddingTop: "4%" }}>
                {line.characters.map((c, i) => (
                  <Img
                    key={i}
                    src={c.spriteUrl}
                    style={{ height: "32%", objectFit: "contain", opacity: 0.82 }}
                  />
                ))}
              </AbsoluteFill>
            )}
            <CaptionOverlay text={line.text} speaker={line.speaker} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
