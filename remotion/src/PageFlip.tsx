import { AbsoluteFill, Img, interpolate, useCurrentFrame } from "remotion";

type PageFlipProps = {
  durationInFrames: number;
  outgoingLeftUrl: string;
  outgoingRightUrl: string;
  incomingLeftUrl: string;
  incomingRightUrl: string;
};

const Spread: React.FC<{ leftUrl: string; rightUrl: string }> = ({ leftUrl, rightUrl }) => (
  <AbsoluteFill>
    <AbsoluteFill style={{ right: "50%" }}>
      <Img src={leftUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </AbsoluteFill>
    <AbsoluteFill style={{ left: "50%" }}>
      <Img src={rightUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </AbsoluteFill>
  </AbsoluteFill>
);

// The page-turn transition played between one scene's spread and the next. First pass: a clean
// single-axis card flip (the whole spread rotating around its vertical center on a CSS 3D
// perspective), not page-curl physics — the outgoing spread is the flip's front face, the
// incoming spread its (pre-mirrored) back face, so at progress 0 this looks identical to the
// outgoing Scene still playing underneath, and at progress 1 identical to the incoming Scene about
// to start, with nothing to visually pop at either boundary.
export const PageFlip: React.FC<PageFlipProps> = ({
  durationInFrames,
  outgoingLeftUrl,
  outgoingRightUrl,
  incomingLeftUrl,
  incomingRightUrl,
}) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const rotateY = progress * 180;
  // A soft shadow that peaks as the flipping spread passes edge-on (90deg) for a bit of depth,
  // gone entirely at both ends where the flip is visually flush with the static scene either side.
  const shadowOpacity = Math.sin(progress * Math.PI) * 0.45;

  return (
    <AbsoluteFill style={{ perspective: 2400 }}>
      <AbsoluteFill style={{ transformStyle: "preserve-3d", transform: `rotateY(${rotateY}deg)` }}>
        <AbsoluteFill style={{ backfaceVisibility: "hidden" }}>
          <Spread leftUrl={outgoingLeftUrl} rightUrl={outgoingRightUrl} />
        </AbsoluteFill>
        <AbsoluteFill style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}>
          <Spread leftUrl={incomingLeftUrl} rightUrl={incomingRightUrl} />
        </AbsoluteFill>
      </AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: `rgba(0,0,0,${shadowOpacity})`, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};
