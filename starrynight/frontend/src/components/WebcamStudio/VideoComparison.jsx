const DownloadIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);

const VideoComparison = ({
  originalUrl,
  processedUrl,
  onReset,
  originalLabel = "Original Capture",
  processedLabel = "Styled Capture",
}) => {
  if (!originalUrl && !processedUrl) return null;

  return (
    <div style={{ marginTop: "20px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
        <div className="neu-card-sm">
          <p className="neu-label" style={{ marginBottom: "10px" }}>{originalLabel}</p>
          {originalUrl ? (
            <div className="neu-media">
              <video key={originalUrl} src={originalUrl} controls preload="metadata" style={{ width: "100%" }}
                onError={(e) => console.error("Original video error:", e.currentTarget.error)} />
            </div>
          ) : (
            <p className="neu-muted" style={{ fontSize: "0.85rem" }}>No clip yet</p>
          )}
        </div>

        <div className="neu-card-sm">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
            <p className="neu-label" style={{ margin: 0 }}>{processedLabel}</p>
            {processedUrl && (
              <a
                href={processedUrl}
                download="styled-capture.mp4"
                className="neu-btn neu-btn-icon"
                title="Download styled video"
                style={{ width: "34px", height: "34px" }}
              >
                <DownloadIcon />
              </a>
            )}
          </div>
          {processedUrl ? (
            <div className="neu-media">
              <video key={processedUrl} src={processedUrl} controls preload="metadata" style={{ width: "100%" }}
                onError={(e) => console.error("Styled video error:", e.currentTarget.error)} />
            </div>
          ) : (
            <p className="neu-muted" style={{ fontSize: "0.85rem" }}>Not ready yet</p>
          )}
        </div>
      </div>

      <button
        type="button"
        className="neu-btn"
        onClick={onReset}
        style={{ marginTop: "16px" }}
      >
        Try Again
      </button>
    </div>
  );
};

export default VideoComparison;
