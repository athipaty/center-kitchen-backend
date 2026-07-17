import { CameraMove } from "./KenBurnsImage";

export type OnScreenCharacter = {
  name: string;
  spriteUrl: string; // sprite matching this character's most recent expression as of this line
};

export type DialogueLineProps = {
  text: string;
  speaker: string | null; // null = narrator, no sprite/name shown
  audioUrl: string;
  durationMs: number;
  // Everyone on screen for this scene (not just whoever's speaking this line), left-to-right in
  // this order — lets two characters share the frame instead of one sprite replacing another
  // in the same center spot every time the speaker changes.
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
