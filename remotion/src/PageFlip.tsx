import { AbsoluteFill, Img, interpolate, useCurrentFrame } from "remotion";

type PageFlipProps = {
  durationInFrames: number;
  outgoingLeftUrl: string;
  outgoingRightUrl: string;
  incomingLeftUrl: string;
  incomingRightUrl: string;
};

// One leaf of the book turning around the spine, not the whole spread rotating as one rigid
// card. Each half — left and right — gets its own perspective and pivots on its own spine-side
// edge (transformOrigin), the way a real book page actually hinges: the front face is the
// outgoing page, the back face is the (pre-mirrored) incoming page, so both halves read as two
// covers opening away from the spine and settling on the new spread, rather than one flat
// rectangle spinning in place.
const FlipHalf: React.FC<{
  side: "left" | "right";
  outgoingUrl: string;
  incomingUrl: string;
  progress: number;
}> = ({ side, outgoingUrl, incomingUrl, progress }) => {
  const spineEdge = side === "left" ? "right" : "left";
  // Left leaf folds away toward the outer-left edge, right leaf toward the outer-right edge —
  // opposite signs so they open away from each other like real covers, not in the same direction.
  const sign = side === "left" ? -1 : 1;
  const rotateY = sign * progress * 180;

  return (
    <AbsoluteFill style={{ [spineEdge === "right" ? "right" : "left"]: "50%", perspective: 2400 }}>
      <AbsoluteFill
        style={{
          transformStyle: "preserve-3d",
          transformOrigin: `${spineEdge} center`,
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
    </AbsoluteFill>
  );
};

// The page-turn transition played between one scene's spread and the next.
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
  // A soft shadow that peaks as the leaves pass edge-on (90deg) for a bit of depth, gone entirely
  // at both ends where the flip is visually flush with the static scene either side.
  const shadowOpacity = Math.sin(progress * Math.PI) * 0.45;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <FlipHalf side="left" outgoingUrl={outgoingLeftUrl} incomingUrl={incomingLeftUrl} progress={progress} />
      <FlipHalf side="right" outgoingUrl={outgoingRightUrl} incomingUrl={incomingRightUrl} progress={progress} />
      <AbsoluteFill style={{ backgroundColor: `rgba(0,0,0,${shadowOpacity})`, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};
