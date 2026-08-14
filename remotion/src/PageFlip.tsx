import { AbsoluteFill, Img, interpolate, useCurrentFrame } from "remotion";

type PageFlipProps = {
  durationInFrames: number;
  outgoingUrl: string;
  incomingUrl: string;
};

// The page hinges along its left edge — like the spine of a book — and rotates over to reveal the
// next scene, instead of spinning in place around its own center like a rotating sign. Front face
// is the outgoing scene's image, back face is the (pre-mirrored) incoming scene's image. Now that
// a scene is a single full-frame image (not a two-page spread with its own spine to hinge on),
// there's one leaf instead of two half-leaves opening away from each other. perspectiveOrigin is
// pinned to the same edge as the hinge so the 3D vanishing point matches where the page is actually
// pivoting, instead of converging on the frame's center while the page rotates off to one side.
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
  // A highlight riding along each face as it turns, brightest right at the edge-on moment — reads
  // as the page catching raking light while it lifts off the surface, same as real paper would.
  const highlightOpacity = Math.pow(Math.sin(progress * Math.PI), 3) * 0.35;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", perspective: 2400, perspectiveOrigin: "0% 50%" }}>
      <AbsoluteFill
        style={{
          transformStyle: "preserve-3d",
          transformOrigin: "left center",
          transform: `rotateY(-${rotateY}deg)`,
        }}
      >
        <AbsoluteFill style={{ backfaceVisibility: "hidden", backgroundColor: "#000" }}>
          <Img src={outgoingUrl} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          <AbsoluteFill
            style={{
              background: "linear-gradient(90deg, transparent 55%, rgba(255,255,255,0.5) 100%)",
              opacity: highlightOpacity,
            }}
          />
        </AbsoluteFill>
        <AbsoluteFill
          style={{ backfaceVisibility: "hidden", backgroundColor: "#000", transform: "rotateY(180deg)" }}
        >
          <Img src={incomingUrl} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          <AbsoluteFill
            style={{
              background: "linear-gradient(270deg, transparent 55%, rgba(255,255,255,0.5) 100%)",
              opacity: highlightOpacity,
            }}
          />
        </AbsoluteFill>
      </AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: `rgba(0,0,0,${shadowOpacity})`, pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};
