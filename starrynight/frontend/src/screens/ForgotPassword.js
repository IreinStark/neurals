import { useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";

const MailIcon = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.45 }}>
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
    <polyline points="22,6 12,13 2,6"/>
  </svg>
);

const KeyIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
  </svg>
);

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetInfo, setResetInfo] = useState(null); // { uid, token }
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError("");
    setResetInfo(null);

    try {
      const { data } = await axios.post("/accounts/forgot-password/", { email });
      if (data.uid && data.token) {
        setResetInfo({ uid: data.uid, token: data.token });
      } else {
        // Email not found — still show a neutral message
        setResetInfo({ notFound: true });
      }
    } catch (err) {
      setError(err?.response?.data?.error || "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const resetLink = resetInfo?.uid
    ? `/reset-password?uid=${resetInfo.uid}&token=${resetInfo.token}`
    : null;

  return (
    <div style={{ padding: "60px 20px", maxWidth: "440px", margin: "0 auto" }}>
      <div className="neu-card">
        <div style={{ textAlign: "center", marginBottom: "24px" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: "12px" }}>
            <MailIcon />
          </div>
          <h2 className="neu-text" style={{ margin: "0 0 6px", fontWeight: 700 }}>Forgot Password</h2>
          <p className="neu-muted" style={{ margin: 0, fontSize: "0.9rem" }}>
            Enter your email and we'll generate a reset link.
          </p>
        </div>

        {!resetInfo ? (
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: "16px" }}>
              <label className="neu-label" style={{ display: "block", marginBottom: "8px" }}>
                Email address
              </label>
              <input
                type="email"
                className="neu-input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>

            {error && (
              <div className="neu-alert danger" style={{ marginBottom: "16px" }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              className="neu-btn neu-btn-accent"
              disabled={loading || !email.trim()}
              style={{ width: "100%", justifyContent: "center", padding: "13px" }}
            >
              <KeyIcon />
              {loading ? "Generating…" : "Get Reset Link"}
            </button>
          </form>
        ) : resetInfo.notFound ? (
          <div className="neu-alert success" style={{ textAlign: "center" }}>
            If that email is registered you will receive a reset link.
          </div>
        ) : (
          <div>
            <div className="neu-alert success" style={{ marginBottom: "20px" }}>
              Reset link generated. Click below to set a new password.
            </div>

            <Link
              to={resetLink}
              className="neu-btn neu-btn-accent"
              style={{ width: "100%", justifyContent: "center", padding: "13px", textDecoration: "none", display: "flex" }}
            >
              <KeyIcon />
              Set New Password
            </Link>

            <div className="neu-inset" style={{ marginTop: "16px", padding: "12px", borderRadius: "var(--neu-radius-sm)" }}>
              <p className="neu-label" style={{ marginBottom: "4px" }}>Reset URL (dev only)</p>
              <p className="neu-muted" style={{ fontSize: "0.75rem", wordBreak: "break-all", margin: 0 }}>
                {window.location.origin}{resetLink}
              </p>
            </div>
          </div>
        )}

        <div className="neu-divider" style={{ margin: "20px 0 16px" }} />
        <div style={{ textAlign: "center" }}>
          <Link to="/login" style={{ color: "var(--neu-accent)", fontSize: "0.9rem", textDecoration: "none" }}>
            ← Back to Login
          </Link>
        </div>
      </div>
    </div>
  );
}
