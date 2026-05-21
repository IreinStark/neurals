import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";

const STATUS_POLL_MS = 2000;

const normalizeStyles = (styles) =>
  (Array.isArray(styles) ? styles : [])
    .filter((s) => s && s.id)
    .map((s) => ({ ...s, label: s.label || s.id }));

const resolveMediaUrl = (url) => {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  const origin =
    window.location.port === "3000"
      ? "http://127.0.0.1:8000"
      : window.location.origin;
  return new URL(url, origin).toString();
};

const DownloadIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);

const UploadIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 16 12 12 8 16"/>
    <line x1="12" y1="12" x2="12" y2="21"/>
    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
  </svg>
);

const VideoIcon = () => (
  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
    <polygon points="23 7 16 12 23 17 23 7"/>
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
  </svg>
);

export default function VideoUpload() {
  const [isAuth, setIsAuth] = useState(false);
  const [styles, setStyles] = useState([]);
  const [selectedStyle, setSelectedStyle] = useState(
    () => localStorage.getItem("video_upload_style") || ""
  );
  const [videoFile, setVideoFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [jobId, setJobId] = useState("");
  const [jobStatus, setJobStatus] = useState("idle");
  const [jobProgress, setJobProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState("");
  const [error, setError] = useState("");
  const [loadingStyles, setLoadingStyles] = useState(true);
  const [stylesError, setStylesError] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const previewUrlRef = useRef("");
  const pollRef = useRef(null);

  useEffect(() => {
    if (localStorage.getItem("userToken") !== null) setIsAuth(true);
  }, []);

  useEffect(() => {
    const restoreLastVideo = async () => {
      // Try DB first (authenticated users)
      try {
        const { data } = await axios.get("/style_transfer/my-videos/");
        const uploads = (data?.videos || []).filter((v) => v.source === "upload");
        if (uploads.length > 0) {
          setResultUrl(resolveMediaUrl(uploads[0].video_url));
          return;
        }
      } catch (_) {}
      // Fallback: localStorage (anonymous / offline)
      const cached = localStorage.getItem("video_upload_result");
      if (cached) setResultUrl(cached);
    };
    restoreLastVideo();
  }, []);

  useEffect(() => {
    axios
      .get("/style_transfer/webcam-styles/")
      .then(({ data }) => {
        const list = normalizeStyles(data?.styles);
        setStyles(list);
        // Only override if no style has been restored yet, or the restored style isn't in the list
        setSelectedStyle((prev) => {
          if (prev && list.some((s) => s.id === prev)) return prev;
          return data?.default_style || list[0]?.id || "";
        });
        setLoadingStyles(false);
      })
      .catch(() => { setLoadingStyles(false); setStylesError(true); });
  }, []);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => clearPoll(), [clearPoll]);

  const applyFile = (file) => {
    if (!file) return;
    setVideoFile(file);
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = URL.createObjectURL(file);
    previewUrlRef.current = url;
    setPreviewUrl(url);
    setResultUrl("");
    setJobId("");
    setJobStatus("idle");
    setError("");
    localStorage.removeItem("video_upload_result");
  };

  const handleFile = (e) => applyFile(e.target.files[0]);

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) applyFile(file);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!videoFile || !selectedStyle) return;

    clearPoll();
    setError("");
    setResultUrl("");
    setJobStatus("queued");
    setJobProgress(0);

    const formData = new FormData();
    formData.append("video", videoFile, videoFile.name);
    formData.append("style", selectedStyle);
    formData.append("source", "upload");

    try {
      const { data } = await axios.post(
        "/style_transfer/webcam-video/",
        formData,
        { headers: { "Content-Type": "multipart/form-data" } }
      );
      const id = data?.job_id || "";
      setJobId(id);
      setJobStatus(data?.status || "queued");

      if (id) {
        pollRef.current = setInterval(async () => {
          try {
            const { data: s } = await axios.get(
              `/style_transfer/video-status/${id}/`
            );
            setJobStatus(s.status);
            setJobProgress(Number(s.progress || 0));
            if (s.status === "completed") {
              clearPoll();
              const resolved = resolveMediaUrl(s.video_url);
              setResultUrl(resolved);
              localStorage.setItem("video_upload_result", resolved);
              localStorage.setItem("video_upload_style", selectedStyle);
            } else if (s.status === "failed") {
              clearPoll();
              setError(s.error || "Processing failed.");
            }
          } catch (_) {}
        }, STATUS_POLL_MS);
      }
    } catch (err) {
      setError(err?.response?.data?.error || "Upload failed.");
      setJobStatus("idle");
    }
  };

  const isProcessing = jobStatus === "queued" || jobStatus === "processing";
  const progressPct = Math.max(5, jobProgress);

  if (!isAuth) {
    return (
      <div style={{ padding: "40px 20px", maxWidth: "780px", margin: "0 auto" }}>
        <div className="neu-alert danger" style={{ marginTop: "24px" }}>
          Please log in to use Video Upload.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "32px 20px", maxWidth: "820px", margin: "0 auto" }}>
      <div className="neu-card" style={{ marginBottom: "24px" }}>
        <h2 className="neu-text" style={{ margin: "0 0 6px", fontWeight: 700 }}>
          Video Style Transfer
        </h2>
        <p className="neu-muted" style={{ margin: 0, fontSize: "0.92rem" }}>
          Upload any video and pick a style. The server processes it frame-by-frame and returns a styled MP4.
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="neu-card" style={{ marginBottom: "20px" }}>
          <label className="neu-label" style={{ display: "block", marginBottom: "12px" }}>
            Video file
          </label>

          <div
            className="neu-file-area"
            style={{
              position: "relative",
              boxShadow: isDragging
                ? "inset 10px 10px 20px var(--neu-shadow-dark), inset -10px -10px 20px var(--neu-shadow-light)"
                : undefined,
              borderRadius: "var(--neu-radius-sm)",
            }}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            <input
              type="file"
              accept="video/*"
              onChange={handleFile}
              style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }}
            />
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", pointerEvents: "none" }}>
              <VideoIcon />
              {videoFile ? (
                <>
                  <span className="neu-text" style={{ fontWeight: 600, fontSize: "0.95rem" }}>{videoFile.name}</span>
                  <span className="neu-muted" style={{ fontSize: "0.8rem" }}>
                    {(videoFile.size / 1024 / 1024).toFixed(1)} MB — click or drag to replace
                  </span>
                </>
              ) : (
                <>
                  <span className="neu-text" style={{ fontWeight: 600 }}>Drop a video here</span>
                  <span className="neu-muted" style={{ fontSize: "0.83rem" }}>or click to browse</span>
                </>
              )}
            </div>
          </div>

          {previewUrl && (
            <div className="neu-media" style={{ marginTop: "16px" }}>
              <video src={previewUrl} controls style={{ width: "100%", display: "block" }} />
            </div>
          )}
        </div>

        <div className="neu-card" style={{ marginBottom: "20px" }}>
          <label className="neu-label" style={{ display: "block", marginBottom: "12px" }}>
            Style
          </label>
          <select
            className="neu-select"
            value={selectedStyle}
            onChange={(e) => setSelectedStyle(e.target.value)}
            disabled={loadingStyles || isProcessing}
          >
            {loadingStyles ? (
              <option>Loading styles…</option>
            ) : stylesError ? (
              <option value="">Could not load styles — is the server running?</option>
            ) : (
              styles.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))
            )}
          </select>
        </div>

        <button
          type="submit"
          className="neu-btn neu-btn-accent"
          disabled={!videoFile || !selectedStyle || isProcessing}
          style={{ width: "100%", justifyContent: "center", padding: "14px" }}
        >
          <UploadIcon />
          {isProcessing ? "Processing…" : "Upload & Apply Style"}
        </button>
      </form>

      {isProcessing && (
        <div className="neu-card" style={{ marginTop: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px" }}>
            <span className="neu-muted" style={{ fontSize: "0.88rem" }}>
              {jobStatus === "queued" ? "Queued — waiting for worker…" : `Processing frames…`}
            </span>
            <span className="neu-accent-text" style={{ fontWeight: 600, fontSize: "0.88rem" }}>
              {jobProgress}%
            </span>
          </div>
          <div className="neu-progress">
            <div className="neu-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          {jobId && (
            <p className="neu-muted" style={{ fontSize: "0.75rem", marginTop: "8px", marginBottom: 0 }}>
              Job ID: {jobId}
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="neu-alert danger" style={{ marginTop: "16px" }}>
          {error}
        </div>
      )}

      {resultUrl && (
        <div className="neu-card" style={{ marginTop: "24px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
            <h5 className="neu-text" style={{ margin: 0, fontWeight: 700 }}>Styled Result</h5>
            <a
              href={resultUrl}
              download="styled-video.mp4"
              className="neu-btn neu-btn-icon"
              title="Download MP4"
            >
              <DownloadIcon />
            </a>
          </div>
          <div className="neu-media">
            <video src={resultUrl} controls style={{ width: "100%", display: "block" }} />
          </div>
        </div>
      )}
    </div>
  );
}
