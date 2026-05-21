const ErrorAlert = ({ message, onRetry, retryLabel = "Retry" }) => {
  if (!message) return null;

  return (
    <div
      className="neu-alert danger"
      style={{ marginTop: "16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}
    >
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="neu-btn neu-btn-danger" onClick={onRetry}
          style={{ padding: "6px 14px", fontSize: "0.85rem", flexShrink: 0 }}>
          {retryLabel}
        </button>
      )}
    </div>
  );
};

export default ErrorAlert;
