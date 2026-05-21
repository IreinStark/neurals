import { useState, useEffect } from "react";
import { Link } from "react-router-dom";

const UserIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>
);

const LockIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
);

function LoginScreen() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (localStorage.getItem("userToken") !== null) {
      window.location.replace("/");
    } else {
      setReady(true);
    }
  }, []);

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/accounts/login/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.access) {
        localStorage.setItem("userToken", JSON.stringify(data));
        window.location.replace("/");
      } else {
        setError("Incorrect username or password.");
        setPassword("");
      }
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setLoading(false);
    }
  };

  if (!ready) return null;

  return (
    <div style={{ padding: "60px 20px", maxWidth: "420px", margin: "0 auto" }}>
      <div className="neu-card">
        <div style={{ textAlign: "center", marginBottom: "28px" }}>
          <img src="/stary.jpg" alt="logo" width="52" height="52"
            style={{ borderRadius: "50%", objectFit: "cover", marginBottom: "12px",
              boxShadow: "4px 4px 10px var(--neu-shadow-dark), -4px -4px 10px var(--neu-shadow-light)" }} />
          <h2 className="neu-text" style={{ margin: "0 0 4px", fontWeight: 700 }}>Welcome back</h2>
          <p className="neu-muted" style={{ margin: 0, fontSize: "0.88rem" }}>Sign in to StarryNight</p>
        </div>

        {error && (
          <div className="neu-alert danger" style={{ marginBottom: "18px" }}>{error}</div>
        )}

        <form onSubmit={onSubmit}>
          <div style={{ marginBottom: "16px" }}>
            <label className="neu-label" style={{ display: "block", marginBottom: "8px" }}>
              Username
            </label>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: "14px", top: "50%", transform: "translateY(-50%)", color: "var(--neu-text-muted)", pointerEvents: "none" }}>
                <UserIcon />
              </span>
              <input
                type="text"
                className="neu-input"
                placeholder="Enter username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
                style={{ paddingLeft: "42px" }}
              />
            </div>
          </div>

          <div style={{ marginBottom: "8px" }}>
            <label className="neu-label" style={{ display: "block", marginBottom: "8px" }}>
              Password
            </label>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: "14px", top: "50%", transform: "translateY(-50%)", color: "var(--neu-text-muted)", pointerEvents: "none" }}>
                <LockIcon />
              </span>
              <input
                type="password"
                className="neu-input"
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                style={{ paddingLeft: "42px" }}
              />
            </div>
          </div>

          <div style={{ textAlign: "right", marginBottom: "22px" }}>
            <Link to="/forgot-password"
              style={{ fontSize: "0.82rem", color: "var(--neu-accent)", textDecoration: "none" }}>
              Forgot password?
            </Link>
          </div>

          <button
            type="submit"
            className="neu-btn neu-btn-accent"
            disabled={loading || !username || !password}
            style={{ width: "100%", justifyContent: "center", padding: "13px", fontSize: "1rem" }}
          >
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>

        <div className="neu-divider" style={{ margin: "22px 0 18px" }} />

        <p className="neu-muted" style={{ textAlign: "center", margin: 0, fontSize: "0.88rem" }}>
          Don't have an account?{" "}
          <Link to="/signup" style={{ color: "var(--neu-accent)", textDecoration: "none", fontWeight: 600 }}>
            Register
          </Link>
        </p>
      </div>

      <div className="neu-card-sm" style={{ marginTop: "16px", textAlign: "center" }}>
        <p className="neu-label" style={{ marginBottom: "6px" }}>Test account</p>
        <p className="neu-muted" style={{ margin: 0, fontSize: "0.82rem" }}>
          Username: <strong className="neu-text">testuser</strong> &nbsp;·&nbsp; Password: <strong className="neu-text">Starry2024!</strong>
        </p>
      </div>
    </div>
  );
}

export default LoginScreen;
