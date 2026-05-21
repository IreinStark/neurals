const Loader = () => (
  <div style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: "40px 0" }}>
    <div style={{
      width: "56px",
      height: "56px",
      borderRadius: "50%",
      background: "var(--neu-bg)",
      boxShadow: "6px 6px 14px var(--neu-shadow-dark), -6px -6px 14px var(--neu-shadow-light)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}>
      <div style={{
        width: "36px",
        height: "36px",
        borderRadius: "50%",
        border: "3px solid transparent",
        borderTopColor: "var(--neu-accent)",
        borderRightColor: "var(--neu-accent)",
        animation: "neu-spin 0.8s linear infinite",
      }} />
    </div>
    <style>{`@keyframes neu-spin { to { transform: rotate(360deg); } }`}</style>
  </div>
);

export default Loader;
