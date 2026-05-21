import { useState, useEffect } from "react";
import { Carousel } from "react-responsive-carousel";
import axios from "axios";
import "react-responsive-carousel/lib/styles/carousel.min.css";
import Loader from "../components/Loader";

const SESSION_KEY = "starrynight_styled_images";
const ALL_STYLES_VALUE = "__all__";

const DownloadIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);

const ImageIcon = () => (
  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>
);

const humanize = (value) =>
  String(value || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

const buildStyleOptions = (payload) => {
  const options = [];

  Object.entries(payload || {}).forEach(([group, value]) => {
    const paths = Array.isArray(value) ? value : [value];
    const normalizedGroup = humanize(group);
    const useGroupAsLabel = paths.length === 1 && group !== "models";

    paths.forEach((modelPath) => {
      const pathParts = String(modelPath).split("/");
      const filename = pathParts[pathParts.length - 1] || modelPath;
      options.push({
        value: modelPath,
        label: useGroupAsLabel ? normalizedGroup : humanize(filename),
      });
    });
  });

  return options.sort((a, b) => a.label.localeCompare(b.label));
};

function StyleTransferCarousel() {
  const [isAuth, setIsAuth] = useState(false);
  const [styledImages, setStyledImages] = useState([]);
  const [activeSlide, setActiveSlide] = useState(0);
  const [availableStyles, setAvailableStyles] = useState([]);
  const [selectedStyle, setSelectedStyle] = useState(ALL_STYLES_VALUE);
  const [loadingStyles, setLoadingStyles] = useState(true);
  const [content, setContent] = useState(null);
  const [contentBase64, setContentBase64] = useState("/stary.jpg");
  const [loader, setLoader] = useState(false);
  const [styled, setStyled] = useState(false);
  const [intensity, setIntensity] = useState(100);
  const [isDragging, setIsDragging] = useState(false);
  const [applyError, setApplyError] = useState("");

  useEffect(() => {
    if (localStorage.getItem("userToken") !== null) setIsAuth(true);
    try {
      const cached = sessionStorage.getItem(SESSION_KEY);
      if (cached) {
        const { images, preview } = JSON.parse(cached);
        if (images && images.length > 0) {
          setStyledImages(images);
          setActiveSlide(0);
          setContentBase64(preview || "/stary.jpg");
          setStyled(true);
        }
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadStyles = async () => {
      setLoadingStyles(true);
      try {
        const response = await axios.get("/style_transfer/models/");
        if (!mounted) return;
        setAvailableStyles(buildStyleOptions(response.data));
        setApplyError("");
      } catch (err) {
        if (!mounted) return;
        setApplyError(
          err?.response?.data?.error ||
            err?.message ||
            "Could not load styles. Check that the backend is running."
        );
      } finally {
        if (mounted) setLoadingStyles(false);
      }
    };

    loadStyles();

    return () => {
      mounted = false;
    };
  }, []);

  const handleImageChange = (file) => {
    if (!file) return;
    setContent(file);
    setContentBase64(URL.createObjectURL(file));
    sessionStorage.removeItem(SESSION_KEY);
    setStyled(false);
    setStyledImages([]);
    setActiveSlide(0);
  };

  const runStyle = async () => {
    if (!content) return;
    setLoader(true);
    setStyled(false);
    setStyledImages([]);
    setApplyError("");
    try {
      let modelList = availableStyles.map((item) => item.value);
      if (modelList.length === 0) {
        const response = await axios.get("/style_transfer/models/");
        modelList = buildStyleOptions(response.data).map((item) => item.value);
        setAvailableStyles(buildStyleOptions(response.data));
      }

      if (modelList.length === 0) {
        throw new Error("No styles are currently available.");
      }

      const stylesToApply =
        selectedStyle === ALL_STYLES_VALUE ? modelList : [selectedStyle];

      const formData = new FormData();
      formData.append("image", content);
      formData.append("style", stylesToApply.join(","));
      formData.append("intensity", (intensity / 100).toFixed(2));

      const { data } = await axios.post("/style_transfer/style/", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      const result = Object.entries(data).map(([model, b64]) => ({
        image: "data:image/png;base64," + b64,
        model,
      }));

      setStyledImages(result);
      setActiveSlide(0);
      setStyled(true);
      setLoader(false);

      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ images: result, preview: contentBase64 }));
      } catch (_) {}
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || "Style transfer failed. Check that the server is running.";
      setApplyError(msg);
      setLoader(false);
    }
  };

  const handleSubmit = (e) => { e.preventDefault(); runStyle(); };
  const currentSlide = styledImages[activeSlide] || styledImages[0] || null;
  const currentLabel = currentSlide
    ? currentSlide.model.split("/").pop().replace(/\.[^.]+$/, "")
    : "";
  const currentFilename = currentLabel ? `${currentLabel}-styled.png` : "styled-image.png";

  if (!isAuth) {
    return (
      <div style={{ padding: "40px 20px", maxWidth: "860px", margin: "0 auto" }}>
        <div className="neu-alert danger" style={{ marginTop: "24px" }}>
          Please log in to continue.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "32px 20px", maxWidth: "860px", margin: "0 auto" }}>
      {loader && <Loader />}

      <div className="neu-card" style={{ marginBottom: "24px" }}>
        <h2 className="neu-text" style={{ margin: "0 0 6px", fontWeight: 700 }}>Image Style Transfer</h2>
        <p className="neu-muted" style={{ margin: 0, fontSize: "0.92rem" }}>
          Upload an image, choose one style or all styles, and compare the results in a carousel.
        </p>
      </div>

      {!styled ? (
        <form onSubmit={handleSubmit}>
          <div className="neu-card" style={{ marginBottom: "20px" }}>
            <label className="neu-label" style={{ display: "block", marginBottom: "12px" }}>Image</label>
            <div
              className="neu-file-area"
              style={{
                position: "relative",
                borderRadius: "var(--neu-radius-sm)",
                boxShadow: isDragging
                  ? "inset 10px 10px 20px var(--neu-shadow-dark), inset -10px -10px 20px var(--neu-shadow-light)"
                  : undefined,
              }}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const file = e.dataTransfer.files[0];
                if (file && file.type.startsWith("image/")) handleImageChange(file);
              }}
            >
              <input
                type="file"
                accept="image/png,image/jpeg"
                onChange={(e) => handleImageChange(e.target.files[0])}
                style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }}
              />
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", pointerEvents: "none" }}>
                <ImageIcon />
                {content ? (
                  <>
                    <span className="neu-text" style={{ fontWeight: 600 }}>{content.name}</span>
                    <span className="neu-muted" style={{ fontSize: "0.8rem" }}>Click or drag to replace</span>
                  </>
                ) : (
                  <>
                    <span className="neu-text" style={{ fontWeight: 600 }}>Drop an image here</span>
                    <span className="neu-muted" style={{ fontSize: "0.83rem" }}>or click to browse — PNG / JPG</span>
                  </>
                )}
              </div>
            </div>

            {contentBase64 !== "/stary.jpg" && (
              <div className="neu-media" style={{ marginTop: "16px" }}>
                <img src={contentBase64} alt="preview" style={{ width: "100%", maxHeight: "340px", objectFit: "contain" }} />
              </div>
            )}
          </div>

          <div className="neu-card" style={{ marginBottom: "20px" }}>
            <label className="neu-label" style={{ display: "block", marginBottom: "12px" }}>
              Style selection
            </label>
            <select
              className="neu-select"
              value={selectedStyle}
              onChange={(e) => setSelectedStyle(e.target.value)}
              disabled={loadingStyles || loader}
            >
              <option value={ALL_STYLES_VALUE}>All styles</option>
              {availableStyles.map((style) => (
                <option key={style.value} value={style.value}>
                  {style.label}
                </option>
              ))}
            </select>
            <p className="neu-muted" style={{ margin: "10px 0 0", fontSize: "0.82rem" }}>
              {loadingStyles
                ? "Loading available style checkpoints..."
                : selectedStyle === ALL_STYLES_VALUE
                  ? "Generate every available style in one run."
                  : "Generate only the selected style and open it directly in the carousel."}
            </p>
          </div>

          <div className="neu-card" style={{ marginBottom: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <label className="neu-label">Style intensity</label>
              <span className="neu-accent-text" style={{ fontWeight: 700, fontSize: "1rem" }}>{intensity}%</span>
            </div>
            <input
              type="range"
              className="neu-range"
              min="10"
              max="100"
              step="5"
              value={intensity}
              onChange={(e) => setIntensity(Number(e.target.value))}
            />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px" }}>
              <span className="neu-muted" style={{ fontSize: "0.75rem" }}>Subtle</span>
              <span className="neu-muted" style={{ fontSize: "0.75rem" }}>Full style</span>
            </div>
          </div>

          {applyError && (
            <div className="neu-alert danger" style={{ marginBottom: "16px" }}>
              {applyError}
            </div>
          )}

          <button
            type="submit"
            className="neu-btn neu-btn-accent"
            disabled={!content || loader || loadingStyles}
            style={{ width: "100%", justifyContent: "center", padding: "14px" }}
          >
            {selectedStyle === ALL_STYLES_VALUE ? "Apply All Styles" : "Apply Selected Style"}
          </button>
        </form>
      ) : (
        <div>
          <div className="neu-card" style={{ marginBottom: "20px" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: "16px", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: "220px" }}>
                <label className="neu-label" style={{ display: "block", marginBottom: "8px" }}>
                  Style selection
                </label>
                <select
                  className="neu-select"
                  value={selectedStyle}
                  onChange={(e) => setSelectedStyle(e.target.value)}
                  disabled={loadingStyles || loader}
                >
                  <option value={ALL_STYLES_VALUE}>All styles</option>
                  {availableStyles.map((style) => (
                    <option key={style.value} value={style.value}>
                      {style.label}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: "200px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                  <label className="neu-label">Intensity</label>
                  <span className="neu-accent-text" style={{ fontWeight: 700 }}>{intensity}%</span>
                </div>
                <input
                  type="range"
                  className="neu-range"
                  min="10"
                  max="100"
                  step="5"
                  value={intensity}
                  onChange={(e) => setIntensity(Number(e.target.value))}
                />
              </div>
              <div style={{ display: "flex", gap: "10px", paddingBottom: "2px" }}>
                {content && (
                  <button
                    type="button"
                    className="neu-btn neu-btn-accent"
                    onClick={runStyle}
                    disabled={loader}
                  >
                    {selectedStyle === ALL_STYLES_VALUE ? "Re-apply All" : "Apply Selected Style"}
                  </button>
                )}
                <button
                  type="button"
                  className="neu-btn"
                  onClick={() => {
                    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
                    setStyled(false);
                    setStyledImages([]);
                    setActiveSlide(0);
                    setContent(null);
                    setContentBase64("/stary.jpg");
                  }}
                >
                  New image
                </button>
              </div>
            </div>
          </div>

          {applyError && (
            <div className="neu-alert danger" style={{ marginBottom: "16px" }}>
              {applyError}
            </div>
          )}

          <div className="neu-card">
            <Carousel
              thumbWidth={90}
              selectedItem={activeSlide}
              onChange={(index) => setActiveSlide(index)}
            >
              {styledImages.map((item) => {
                const label = item.model.split("/").pop().replace(/\.[^.]+$/, "");
                return (
                  <div key={item.model}>
                    <img src={item.image} alt={label} />
                    <p className="legend">{label}</p>
                  </div>
                );
              })}
            </Carousel>

          </div>

          <div className="neu-card" style={{ marginTop: "12px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
            <div>
              <div className="neu-muted" style={{ fontSize: "0.8rem", marginBottom: "4px" }}>
                {styledImages.length} styles generated
              </div>
              <div className="neu-text" style={{ fontWeight: 700 }}>
                {currentLabel || "Current style"}
              </div>
            </div>
            {currentSlide ? (
              <a
                href={currentSlide.image}
                download={currentFilename}
                className="neu-btn"
                title={`Download ${currentLabel}`}
                style={{ textDecoration: "none" }}
              >
                <DownloadIcon />
                Download Current Image
              </a>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

export default StyleTransferCarousel;
