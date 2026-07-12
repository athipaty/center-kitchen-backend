import { CameraMove } from "./KenBurnsImage";

export type DialogueLineProps = {
  text: string;
  speaker: string | null; // null = narrator, no sprite/name shown
  spriteUrl: string | null; // this line's character sprite (matching expression), null if narrator
  audioUrl: string;
  durationMs: number;
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
