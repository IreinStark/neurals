import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import axios from "axios";

const EyeIcon = ({ open }) => open ? (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
) : (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

const CheckIcon = () => (
  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--neu-success)" }}>
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
    <polyline points="22 4 12 14.01 9 11.01"/>
  </svg>
);

export default function ResetPassword() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const uid = params.get("uid") || "";
  const token = params.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const mismatch = confirm && password !== confirm;
  const tooShort = password && password.length < 6;
  const canSubmit = password.length >= 6 && password === confirm && !loading;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError("");

    try {
      await axios.post("/accounts/reset-password/", { uid, token, password });
      setDone(true);
    } catch (err) {
      setError(err?.response?.data?.error || "Reset failed. The link may have expired.");
    } finally {
      setLoading(false);
    }
  };

  if (!uid || !token) {
    return (
      <div style={{ padding: "60px 20px", maxWidth: "440px", margin: "0 auto" }}>
        <div className="neu-card">
          <div className="neu-alert danger">Invalid reset link — uid or token is missing.</div>
          <div style={{ textAlign: "center", marginTop: "16px" }}>
            <Link to="/forgot-password" style={{ color: "var(--neu-accent)", textDecoration: "none" }}>
              Request a new link
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "60px 20px", maxWidth: "440px", margin: "0 auto" }}>
      <div className="neu-card">
        {done ? (
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: "16px" }}>
              <CheckIcon />
            </div>
            <h2 className="neu-text" style={{ margin: "0 0 8px", fontWeight: 700 }}>Password Updated</h2>
            <p className="neu-muted" style={{ marginBottom: "24px" }}>
              Your password has been changed. You can now log in.
            </p>
            <Link
              to="/login"
              className="neu-btn neu-btn-accent"
              style={{ justifyContent: "center", padding: "12px 32px", textDecoration: "none", display: "inline-flex" }}
            >
              Go to Login
            </Link>
          </div>
        ) : (
          <>
            <div style={{ textAlign: "center", marginBottom: "24px" }}>
              <h2 className="neu-text" style={{ margin: "0 0 6px", fontWeight: 700 }}>Set New Password</h2>
              <p className="neu-muted" style={{ margin: 0, fontSize: "0.9rem" }}>
                Choose a new password for your account.
              </p>
            </div>

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: "16px" }}>
                <label className="neu-label" style={{ display: "block", marginBottom: "8px" }}>
                  New password
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    type={showPw ? "text" : "password"}
                    className="neu-input"
                    placeholder="At least 6 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus
                    style={{ paddingRight: "44px" }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((v) => !v)}
                    style={{ position: "absolute", right: "12px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--neu-text-muted)", padding: 0 }}
                    aria-label="Toggle password visibility"
                  >
                    <EyeIcon open={showPw} />
                  </button>
                </div>
                {tooShort && (
                  <p style={{ color: "var(--neu-danger)", fontSize: "0.78rem", margin: "6px 0 0" }}>
                    At least 6 characters required
                  </p>
                )}
              </div>

              <div style={{ marginBottom: "20px" }}>
                <label className="neu-label" style={{ display: "block", marginBottom: "8px" }}>
                  Confirm password
                </label>
                <input
                  type={showPw ? "text" : "password"}
                  className="neu-input"
                  placeholder="Repeat password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
                {mismatch && (
                  <p style={{ color: "var(--neu-danger)", fontSize: "0.78rem", margin: "6px 0 0" }}>
                    Passwords do not match
                  </p>
                )}
              </div>

              {error && (
                <div className="neu-alert danger" style={{ marginBottom: "16px" }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="neu-btn neu-btn-accent"
                disabled={!canSubmit}
                style={{ width: "100%", justifyContent: "center", padding: "13px" }}
              >
                {loading ? "Saving…" : "Update Password"}
              </button>
            </form>
          </>
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
