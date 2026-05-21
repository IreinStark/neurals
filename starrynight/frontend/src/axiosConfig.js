import axios from "axios";

const getValidAccessToken = () => {
  try {
    const raw = localStorage.getItem("userToken");
    if (!raw) return null;
    const token = JSON.parse(raw);
    if (!token?.access) return null;
    // Decode payload to check expiry without a library
    const payload = JSON.parse(atob(token.access.split(".")[1]));
    if (payload.exp * 1000 < Date.now()) return null; // expired
    return token.access;
  } catch (_) {
    return null;
  }
};

// Attach Bearer token only when valid and not expired
axios.interceptors.request.use((config) => {
  const access = getValidAccessToken();
  if (access) {
    config.headers = config.headers || {};
    config.headers["Authorization"] = `Bearer ${access}`;
  }
  return config;
});

// Clear a token that the server says is invalid so it stops being sent
axios.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err?.response?.status === 401) {
      // Only clear if we actually sent a token (avoid clearing on truly anon requests)
      if (err?.config?.headers?.Authorization) {
        localStorage.removeItem("userToken");
      }
    }
    return Promise.reject(err);
  }
);
