import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useTheme } from "../context/ThemeContext";

const SunIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="5"/>
    <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
    <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
  </svg>
);

const MoonIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>
);

const DefaultNavbar = () => {
  const [isAuth, setIsAuth] = useState(false);
  const { theme, toggle } = useTheme();

  useEffect(() => {
    if (localStorage.getItem("userToken") !== null) setIsAuth(true);
  }, []);

  const logout = () => {
    localStorage.removeItem("userToken");
    window.location.replace("/");
  };

  return (
    <nav className="neu-navbar" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <Link to="/" style={{ display: "flex", alignItems: "center", textDecoration: "none" }}>
          <img src="/stary.jpg" width="32" height="32" style={{ borderRadius: "50%", objectFit: "cover" }} alt="logo" />
          <span style={{ marginLeft: "10px", fontWeight: 700, fontSize: "1.1rem", color: "var(--neu-accent)" }}>StarryNight</span>
        </Link>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap" }}>
        <NavItem to="/style_transfer">Image Transfer</NavItem>
        <NavItem to="/webcam">Webcam Studio</NavItem>
        <NavItem to="/video-upload">Video Upload</NavItem>
        {isAuth ? (
          <button className="neu-btn neu-btn-danger" style={{ fontSize: "0.9rem" }} onClick={logout}>
            Logout
          </button>
        ) : (
          <>
            <NavItem to="/login">Login</NavItem>
            <NavItem to="/signup">Signup</NavItem>
          </>
        )}
        <button
          className="neu-btn neu-btn-icon"
          onClick={toggle}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          style={{ marginLeft: "4px" }}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </nav>
  );
};

const NavItem = ({ to, children }) => (
  <Link
    to={to}
    style={{
      display: "inline-flex",
      alignItems: "center",
      padding: "8px 14px",
      borderRadius: "var(--neu-radius-sm)",
      color: "var(--neu-text)",
      textDecoration: "none",
      fontWeight: 500,
      fontSize: "0.9rem",
      transition: "color 0.2s",
    }}
    onMouseEnter={e => (e.currentTarget.style.color = "var(--neu-accent)")}
    onMouseLeave={e => (e.currentTarget.style.color = "var(--neu-text)")}
  >
    {children}
  </Link>
);

export default DefaultNavbar;
