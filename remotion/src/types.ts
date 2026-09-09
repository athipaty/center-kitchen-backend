export type DialogueLineProps = {
  audioUrl: string;
  durationMs: number;
  text: string;
};

// A scene renders as one full-frame illustration. No per-line portrait/caption data: consistency
// across scenes comes from the image prompts themselves (see jobs/youtubeEpisodeScheduler.js's
// stepImages), not from anything Scene.tsx composites on top. videoUrl is an optional opt-in
// upgrade (Kling image-to-video, see falVideo.js) - when set, Scene.tsx plays it (looped, since
// Kling's clip length rarely matches the scene's actual narration length) instead of panning/
// zooming imageUrl. imageUrl is always present regardless, both as the source frame and fallback.
export type SceneProps = {
  imageUrl: string;
  videoUrl?: string | null;
  videoDurationMs?: number | null;
  dialogue: DialogueLineProps[];
};

export type IntroProps = {
  text: string;
  audioUrl: string | null;
  durationMs: number | null;
};

export type EpisodeProps = {
  title?: string;
  intro?: IntroProps | null;
  scenes: SceneProps[];
  bgmUrl?: string | null;
};
