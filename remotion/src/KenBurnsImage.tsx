import { AbsoluteFill, Img, interpolate, useCurrentFrame } from "remotion";

export type CameraMove = "pan-left" | "pan-right" | "zoom-in" | "zoom-out" | "static";

// A slow pan/zoom over a still image — the whole "motion" in a motion comic background, since
// there's no real camera and no animated character movement in this v1 composition.
export const KenBurnsImage: React.FC<{
  src: string;
  durationInFrames: number;
  move: CameraMove;
}> = ({ src, durationInFrames, move }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [0, durationInFrames], [0, 1], { extrapolateRight: "clamp" });

  // Scale stays >=1 for the whole range so pans never reveal the image edge; zooms go from
  // 1 -> 1.15 (in) or 1.15 -> 1 (out). Pans hold a fixed 1.1 scale and translate across it.
  let scale = 1.1;
  let translateX = 0;
  const panDistance = 4; // percent of width

  if (move === "zoom-in") scale = 1 + t * 0.15;
  else if (move === "zoom-out") scale = 1.15 - t * 0.15;
  else if (move === "pan-left") translateX = panDistance - t * panDistance * 2;
  else if (move === "pan-right") translateX = -panDistance + t * panDistance * 2;

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img
        src={src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale}) translateX(${translateX}%)`,
        }}
      />
    </AbsoluteFill>
  );
};
