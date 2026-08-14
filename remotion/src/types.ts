export type DialogueLineProps = {
  audioUrl: string;
  durationMs: number;
  text: string;
};

// A scene renders as one full-frame illustration. No per-line portrait/caption data: consistency
// across scenes comes from the image prompts themselves (see jobs/youtubeEpisodeScheduler.js's
// stepImages), not from anything Scene.tsx composites on top.
export type SceneProps = {
  imageUrl: string;
  dialogue: DialogueLineProps[];
};

export type EpisodeProps = {
  scenes: SceneProps[];
  bgmUrl?: string | null;
};
