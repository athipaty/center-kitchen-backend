import { AbsoluteFill, Audio, CalculateMetadataFunction, Composition, Sequence } from "remotion";
import { Scene } from "./Scene";
import { PageFlip } from "./PageFlip";
import type { EpisodeProps } from "./types";

export const FPS = 30;
const WIDTH = 1280;
const HEIGHT = 720;

// Length of the page-flip transition straddling each scene boundary, within the plan's suggested
// 15-20 frame window (0.6s at 30fps) — long enough to read as a deliberate page turn, short enough
// not to eat into narration pacing.
const TRANSITION_FRAMES = 18;

const sceneDurationInFrames = (scene: EpisodeProps["scenes"][number]) => {
  const totalMs = scene.dialogue.reduce((sum, line) => sum + line.durationMs, 0);
  return Math.max(FPS, Math.round((totalMs / 1000) * FPS)); // at least 1s even if a scene has no dialogue
};

const totalDurationInFrames = (props: EpisodeProps) =>
  props.scenes.reduce((sum, scene) => sum + sceneDurationInFrames(scene), 0);

const calculateMetadata: CalculateMetadataFunction<EpisodeProps> = ({ props }) => {
  return { durationInFrames: Math.max(FPS, totalDurationInFrames(props)) };
};

// Registered as composition id "Episode" — this is what remotion/render.js selects via
// selectComposition({id: 'Episode', ...}). Duration is entirely derived from the input props
// (dialogue line durations from the TTS step), not hardcoded, since every episode is a different length.
export const EpisodeCompositionRoot: React.FC = () => {
  return (
    <Composition
      id="Episode"
      component={EpisodeVideo}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      durationInFrames={FPS * 10} // placeholder — calculateMetadata overrides this per-render
      defaultProps={{ scenes: [], bgmUrl: null } as EpisodeProps}
      calculateMetadata={calculateMetadata}
    />
  );
};

export const EpisodeVideo: React.FC<EpisodeProps> = ({ scenes, bgmUrl }) => {
  const durations = scenes.map(sceneDurationInFrames);
  const starts: number[] = [];
  {
    let cursor = 0;
    for (const d of durations) {
      starts.push(cursor);
      cursor += d;
    }
  }

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* No royalty-free track is bundled in v1 (nothing to safely ship without sourcing/
          licensing it properly) — bgmUrl is optional, pass one in per-episode if you have a
          track, otherwise the episode renders with just narration/dialogue audio. */}
      {bgmUrl && <Audio src={bgmUrl} loop volume={0.15} />}
      {scenes.map((scene, i) => (
        <Sequence key={i} from={starts[i]} durationInFrames={durations[i]} layout="none">
          <Scene {...scene} durationInFrames={durations[i]} />
        </Sequence>
      ))}
      {/* One page-flip overlay per scene boundary, straddling it symmetrically (half the
          transition before, half after) so it starts identical to the outgoing Scene still
          playing underneath and ends identical to the incoming Scene about to take over — the
          underlying per-line <Audio> Sequences inside Scene keep playing on their own schedule
          throughout, this is a purely visual overlay. Clamped to half of whichever adjacent
          scene is shorter so a very short scene can't make the transition overrun into the one
          after next. */}
      {scenes.slice(0, -1).map((scene, i) => {
        const next = scenes[i + 1];
        const half = Math.min(TRANSITION_FRAMES / 2, durations[i] / 2, durations[i + 1] / 2);
        const from = Math.round(starts[i + 1] - half);
        const durationInFrames = Math.max(1, Math.round(half * 2));
        return (
          <Sequence key={`flip-${i}`} from={from} durationInFrames={durationInFrames} layout="none">
            <PageFlip
              durationInFrames={durationInFrames}
              outgoingLeftUrl={scene.leftPageUrl}
              outgoingRightUrl={scene.rightPageUrl}
              incomingLeftUrl={next.leftPageUrl}
              incomingRightUrl={next.rightPageUrl}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
