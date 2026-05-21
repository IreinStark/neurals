const ProcessingStatus = ({ jobId, status, progress, error }) => {
  if (!jobId || status === "idle") return null;

  const safeProgress = Math.max(0, Math.min(100, progress || 0));

  return (
    <div className="neu-card-sm" style={{ marginTop: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
        <span className="neu-muted" style={{ fontSize: "0.8rem" }}>
          Job: <span style={{ fontFamily: "monospace" }}>{jobId.slice(0, 16)}…</span>
        </span>
        <span
          className="neu-badge"
          style={{
            color: status === "completed"
              ? "var(--neu-success)"
              : status === "failed"
                ? "var(--neu-danger)"
                : "var(--neu-accent)",
          }}
        >
          {status}
        </span>
      </div>
      <div className="neu-progress">
        <div className="neu-progress-fill" style={{ width: `${Math.max(2, safeProgress)}%` }} />
      </div>
      {error && (
        <div className="neu-alert danger" style={{ marginTop: "10px", fontSize: "0.85rem" }}>
          {error}
        </div>
      )}
    </div>
  );
};

export default ProcessingStatus;
