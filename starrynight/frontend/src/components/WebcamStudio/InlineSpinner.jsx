const InlineSpinner = ({ label = "Loading..." }) => (
  <div style={{ display: "flex", alignItems: "center", gap: "10px", margin: "12px 0" }} role="status" aria-live="polite">
    <div style={{
      width: "18px",
      height: "18px",
      borderRadius: "50%",
      border: "2px solid transparent",
      borderTopColor: "var(--neu-accent)",
      borderRightColor: "var(--neu-accent)",
      animation: "neu-spin 0.8s linear infinite",
      flexShrink: 0,
    }} />
    <span className="neu-muted" style={{ fontSize: "0.88rem" }}>{label}</span>
    <style>{`@keyframes neu-spin { to { transform: rotate(360deg); } }`}</style>
  </div>
);

export default InlineSpinner;
