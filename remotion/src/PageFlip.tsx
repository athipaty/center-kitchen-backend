import { AbsoluteFill, Img, interpolate, useCurrentFrame } from "remotion";

type PageFlipProps = {
  durationInFrames: number;
  outgoingUrl: string;
  incomingUrl: string;
};

// The whole frame flips over in place around its vertical center axis — front face is the
// outgoing scene's image, back face is the (pre-mirrored) incoming scene's image, so the flip
// reads as one page turning over to reveal the next. Now that a scene is a single full-frame
// image (not a two-page spread with its own spine to hinge on), there's one leaf instead of two
// half-leaves opening away from each other.
export const PageFlip: React.FC<PageFlipProps> = ({ durationInFrames, outgoingUrl, incomingUrl }) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const rotateY = progress * 180;
  // A soft shadow that peaks as the page passes edge-on (90deg) for a bit of depth, gone entirely
  // at both ends where the flip is visually flush with the static scene either side.
  const shadowOpacity = Math.sin(progress * Math.PI) * 0.45;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", perspective: 2400 }}>
      <AbsoluteFill
        style={{
          transformStyle: "preserve-3d",
          transformOrigin: "center center",
          transform: `rotateY(${rotateY}deg)`,
        }}
      >
        <AbsoluteFill style={{ backfaceVisibility: "hidden", backgroundColor: "#000" }}>
          <Img src={outgoingUrl} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        </AbsoluteFill>
        <AbsoluteFill
          style={{ backfaceVisibility: "hidden", backgroundColor: "#000", transform: "rotateY(180deg)" }}
        >
          <Img src={incomingUrl} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        </AbsoluteFill>
      </AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: `rgba(0,0,0,${shadowOpacity})`, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};
