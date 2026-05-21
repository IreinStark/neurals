const RecordIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="12" cy="12" r="8"/>
  </svg>
);

const StopIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <rect x="4" y="4" width="16" height="16" rx="2"/>
  </svg>
);

const RecordControls = ({
  isRecording,
  recordingTimeMs,
  maxDurationMs = 30000,
  onStartRecording,
  onStopRecording,
  statusText,
  isProcessing,
  actionLabel,
  onAction,
  canAction,
}) => {
  const seconds = Math.floor(recordingTimeMs / 1000);
  const maxSeconds = Math.floor(maxDurationMs / 1000);
  const progressPct = Math.min(100, (recordingTimeMs / maxDurationMs) * 100);

  return (
    <div className="neu-card" style={{ marginTop: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "14px" }}>
        <button
          type="button"
          className="neu-btn neu-btn-success"
          disabled={isRecording}
          onClick={onStartRecording}
          style={{ gap: "8px" }}
        >
          <RecordIcon />
          Record
        </button>
        <button
          type="button"
          className="neu-btn neu-btn-danger"
          disabled={!isRecording}
          onClick={onStopRecording}
          style={{ gap: "8px" }}
        >
          <StopIcon />
          Stop
        </button>
        {actionLabel && onAction && (
          <button
            type="button"
            className="neu-btn neu-btn-accent"
            disabled={!canAction || isRecording || isProcessing}
            onClick={onAction}
          >
            {actionLabel}
          </button>
        )}
      </div>

      {isRecording && (
        <div style={{ marginBottom: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
            <span className="neu-muted" style={{ fontSize: "0.8rem" }}>Recording</span>
            <span className="neu-accent-text" style={{ fontWeight: 600, fontSize: "0.8rem" }}>
              {seconds}s / {maxSeconds}s
            </span>
          </div>
          <div className="neu-progress">
            <div className="neu-progress-fill" style={{ width: `${Math.max(2, progressPct)}%` }} />
          </div>
        </div>
      )}

      <p className="neu-muted" style={{ fontSize: "0.8rem", margin: "0 0 4px" }}>
        Keep clips short for faster processing.
      </p>
      <p className="neu-text" style={{ fontSize: "0.85rem", margin: 0 }}>
        Status: <span className="neu-accent-text">{statusText}</span>
      </p>
    </div>
  );
};

export default RecordControls;
