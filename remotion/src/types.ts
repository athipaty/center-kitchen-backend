export type DialogueLineProps = {
  audioUrl: string;
  durationMs: number;
};

// A scene renders as a two-page storybook spread — leftPageUrl a wider establishing framing,
// rightPageUrl a closer character-focused framing of the same moment. No per-line portrait/
// caption data: consistency across pages comes from the image prompts themselves (see
// jobs/youtubeEpisodeScheduler.js's stepImages), not from anything Scene.tsx composites on top.
export type SceneProps = {
  leftPageUrl: string;
  rightPageUrl: string;
  dialogue: DialogueLineProps[];
};

export type EpisodeProps = {
  scenes: SceneProps[];
  bgmUrl?: string | null;
};
