import { AbsoluteFill, Audio, CalculateMetadataFunction, Composition, Sequence } from "remotion";
import { Scene } from "./Scene";
import type { EpisodeProps } from "./types";

export const FPS = 30;
const WIDTH = 1280;
const HEIGHT = 720;

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
  let cursor = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* No royalty-free track is bundled in v1 (nothing to safely ship without sourcing/
          licensing it properly) — bgmUrl is optional, pass one in per-episode if you have a
          track, otherwise the episode renders with just narration/dialogue audio. */}
      {bgmUrl && <Audio src={bgmUrl} loop volume={0.15} />}
      {scenes.map((scene, i) => {
        const durationInFrames = sceneDurationInFrames(scene);
        const from = cursor;
        cursor += durationInFrames;
        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames} layout="none">
            <Scene {...scene} durationInFrames={durationInFrames} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
