import { CameraMove } from "./KenBurnsImage";

export type OnScreenCharacter = {
  name: string;
  spriteUrl: string; // sprite matching this character's most recent expression as of this line
  // Stable left-to-right position among this scene's cast (0 = first), constant for the whole
  // scene so a given character always speaks from the same edge instead of jumping around as
  // the speaker changes line to line.
  slot: number;
};

export type DialogueLineProps = {
  text: string;
  speaker: string | null; // null = narrator, no sprite/name shown
  audioUrl: string;
  durationMs: number;
  // Everyone on screen for this scene (not just whoever's speaking this line) — carries each
  // character's fixed slot so Scene.tsx can place the current speaker's portrait consistently,
  // but only the one matching `speaker` is actually rendered for a given line.
  characters: OnScreenCharacter[];
};

export type SceneProps = {
  backgroundUrl: string;
  cameraMove: CameraMove;
  dialogue: DialogueLineProps[];
};

export type EpisodeProps = {
  scenes: SceneProps[];
  bgmUrl?: string | null;
};
