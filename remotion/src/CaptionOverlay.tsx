// Simple bottom-of-frame caption bar — v1 shows the whole line at once (no word-by-word
// karaoke-style highlighting), synced to the same Sequence as the line's audio.
export const CaptionOverlay: React.FC<{ text: string; speaker: string | null }> = ({ text, speaker }) => {
  if (!text) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: "8%",
        right: "8%",
        bottom: "8%",
        textAlign: "center",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      }}
    >
      {speaker && (
        <div
          style={{
            display: "inline-block",
            background: "#8b5cf6",
            color: "white",
            fontWeight: 700,
            fontSize: 22,
            padding: "2px 14px",
            borderRadius: 999,
            marginBottom: 8,
          }}
        >
          {speaker}
        </div>
      )}
      <div
        style={{
          background: "rgba(15, 23, 42, 0.75)",
          color: "white",
          fontWeight: 600,
          fontSize: 34,
          lineHeight: 1.35,
          padding: "14px 22px",
          borderRadius: 16,
        }}
      >
        {text}
      </div>
    </div>
  );
};
