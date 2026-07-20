import { AbsoluteFill, Audio, Img, Sequence, useVideoConfig } from "remotion";
import { KenBurnsImage } from "./KenBurnsImage";
import { CaptionOverlay } from "./CaptionOverlay";
import type { SceneProps } from "./types";

const msToFrames = (ms: number, fps: number) => Math.max(1, Math.round((ms / 1000) * fps));

// Percent-from-edge margin for a lone speaker's portrait. Positions are driven by each
// character's fixed `slot`, not how many are currently speaking, so a two-character scene always
// puts character 0 near the left edge and character 1 near the right edge, line to line, rather
// than the portrait re-centering itself each time the speaker changes.
const EDGE_MARGIN_PCT = 7;
const PORTRAIT_SIZE_PCT = 26;

function slotToLeftPct(slot: number, totalSlots: number): number {
  if (totalSlots <= 1) return 50;
  return EDGE_MARGIN_PCT + (slot / (totalSlots - 1)) * (100 - 2 * EDGE_MARGIN_PCT);
}

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
        // Only the character currently speaking gets a portrait — a listening character's sprite
        // sitting on screen unchanged read as clutter, not as "this person is in the scene".
        const speaking = line.characters.find((c) => c.name === line.speaker);
        const leftPct = speaking ? slotToLeftPct(speaking.slot, line.characters.length) : 50;
        return (
          <Sequence key={i} from={from} durationInFrames={lineFrames} layout="none">
            <Audio src={line.audioUrl} />
            {speaking && (
              <div
                style={{
                  position: "absolute",
                  top: "6%",
                  left: `${leftPct}%`,
                  transform: "translateX(-50%)",
                  width: `${PORTRAIT_SIZE_PCT}%`,
                  aspectRatio: "1 / 1",
                  borderRadius: "50%",
                  overflow: "hidden",
                  border: "4px solid rgba(255,255,255,0.9)",
                  boxShadow: "0 6px 20px rgba(0,0,0,0.3)",
                }}
              >
                <Img src={speaking.spriteUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              </div>
            )}
            <CaptionOverlay text={line.text} speaker={line.speaker} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
