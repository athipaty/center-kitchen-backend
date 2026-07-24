// Speech bubble for a speaking character's line — sits next to their portrait near the top of
// frame instead of the bottom caption bar CaptionOverlay uses for narrator lines. Anchored off the
// portrait's inner edge (the edge facing the center of frame) so it never overlaps the portrait,
// and grows toward center from whichever side the character is on.
const BUBBLE_GAP_PCT = 3;
const BUBBLE_WIDTH_PCT = 42;

export const SpeechBubble: React.FC<{ text: string; leftPct: number; portraitSizePct: number }> = ({
  text,
  leftPct,
  portraitSizePct,
}) => {
  if (!text) return null;
  const isLeftSide = leftPct <= 50;
  const portraitInnerEdge = isLeftSide ? leftPct + portraitSizePct / 2 : leftPct - portraitSizePct / 2;
  const horizontal = isLeftSide
    ? { left: `${portraitInnerEdge + BUBBLE_GAP_PCT}%`, width: `${BUBBLE_WIDTH_PCT}%` }
    : { right: `${100 - portraitInnerEdge + BUBBLE_GAP_PCT}%`, width: `${BUBBLE_WIDTH_PCT}%` };

  return (
    <div
      style={{
        position: "absolute",
        top: "8%",
        ...horizontal,
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          background: "rgba(15, 23, 42, 0.5)",
          color: "white",
          fontWeight: 600,
          fontSize: 30,
          lineHeight: 1.35,
          padding: "14px 20px",
          borderRadius: 16,
        }}
      >
        {text}
      </div>
    </div>
  );
};
