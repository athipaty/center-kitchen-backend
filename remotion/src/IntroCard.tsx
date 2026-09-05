import { AbsoluteFill, Audio, Img, interpolate, useCurrentFrame } from "remotion";

type IntroCardProps = {
  durationInFrames: number;
  title: string;
  audioUrl: string | null;
  imageUrl: string | null;
};

// A title card read aloud before the story starts — the episode title over scene 1's own image
// (no extra image generation, since that image already exists by the time this renders) with a
// gentle zoom-in and a dark gradient behind the text for legibility, playing the intro line's
// audio. When there's no scene 1 image yet (shouldn't happen in practice — images are a required
// earlier step) it falls back to a plain dark background rather than crashing on a missing src.
export const IntroCard: React.FC<IntroCardProps> = ({ durationInFrames, title, audioUrl, imageUrl }) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, durationInFrames], [1.06, 1.16], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // Fades in/out at the very edges only (a few frames) so it doesn't cut jarringly into the first
  // page-flip transition or in from black.
  const fade = Math.min(
    interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
    interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", opacity: fade }}>
      {imageUrl && (
        <Img
          src={imageUrl}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: `scale(${scale})`,
            transformOrigin: "center center",
          }}
        />
      )}
      <AbsoluteFill style={{ background: "linear-gradient(rgba(0,0,0,0.15), rgba(0,0,0,0.75))" }} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "0 80px" }}>
        <div
          style={{
            fontFamily: "'Noto Sans Thai', 'Noto Sans', sans-serif",
            fontSize: 64,
            fontWeight: 800,
            color: "#fff",
            textAlign: "center",
            lineHeight: 1.25,
            textShadow: "0 4px 16px rgba(0,0,0,0.7)",
          }}
        >
          {title}
        </div>
      </AbsoluteFill>
      {audioUrl && <Audio src={audioUrl} />}
    </AbsoluteFill>
  );
};
