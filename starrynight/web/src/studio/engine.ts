/**
 * Neural Style Studio engine — the real functionality behind the designer's UI.
 *
 * The design file (web/studio/index.html) keeps its own markup and styling; wherever it
 * used to fake something (CSS colour filters, timed progress bars, fake sign-in), it now
 * calls `window.NS`, defined here:
 *   - NS.stylizeImage / NS.live   → in-browser TransformerNet ONNX via style-preview-worker
 *   - NS.api                      → Django (auth, video jobs) through the same-origin proxy
 *   - NS.auth / NS.gallery        → session + persistent gallery (IndexedDB)
 */
import type { StyleId } from "@/contracts/styles";
import type { ExecutionProvider } from "@/contracts/worker";
import { StyleClient, StyleError, type StyleResult } from "@/ml/styleClient";

/** Design style keys → trained model ids. */
export const DESIGN_STYLES: Record<string, StyleId> = {
  starry: "starry-night",
  wave: "wave",
  cyber: "tokyo-ghoul",
  garden: "lazy",
};

const scriptUrl = (document.currentScript as HTMLScriptElement | null)?.src ?? `${location.origin}/studio/engine.js`;
const workerUrl = new URL("./style-preview-worker.js", scriptUrl);

let client: StyleClient | null = null;
function getClient(): StyleClient {
  if (!client) client = new StyleClient(new Worker(workerUrl, { type: "module", name: "style-preview-worker" }));
  return client;
}

function styleFor(key: string): StyleId | null {
  return DESIGN_STYLES[key] ?? null;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

function toCanvas(result: StyleResult): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = result.width;
  c.height = result.height;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height), 0, 0);
  return c;
}

// --------------------------------------------------------------- images ---
export interface ImageStyleResult {
  dataUrl: string;
  ms: number;
  ep: ExecutionProvider;
  width: number;
  height: number;
}

const imageCache = new Map<string, Promise<ImageStyleResult>>();

/** Stylize an image (data URL or URL) with a design style key. Cached per (src, style, size). */
function stylizeImage(src: string, key: string, maxSide = 512): Promise<ImageStyleResult> {
  const styleId = styleFor(key);
  if (!styleId) return Promise.reject(new StyleError("internal", `Unknown style ${key}`));
  const cacheKey = `${styleId}|${maxSide}|${src.length}|${src.slice(-64)}`;
  let p = imageCache.get(cacheKey);
  if (!p) {
    p = (async () => {
      const img = await loadImage(src);
      const res = await getClient().stylizeSource(styleId, img, img.naturalWidth, img.naturalHeight, maxSide);
      const canvas = toCanvas(res);
      return {
        dataUrl: canvas.toDataURL("image/jpeg", 0.92),
        ms: Math.round(res.timings.totalMs),
        ep: res.ep,
        width: res.width,
        height: res.height,
      };
    })();
    p.catch(() => imageCache.delete(cacheKey));
    imageCache.set(cacheKey, p);
    while (imageCache.size > 24) imageCache.delete(imageCache.keys().next().value as string);
  }
  return p;
}

/** Warm a style's model so the first click feels instant. */
function preload(key: string): void {
  const id = styleFor(key);
  if (id) getClient().init(id).catch(() => undefined);
}

// ----------------------------------------------------------------- live ---
export interface LiveStats {
  fps: number;
  latencyMs: number;
  glassToGlassMs: number;
  ep: ExecutionProvider | null;
}

/**
 * Real-time stylization of a <video> into a <canvas>. Frames are sent to the worker one
 * at a time (no backlog); each result is painted as soon as it arrives.
 */
function live(video: HTMLVideoElement, canvas: HTMLCanvasElement, opts: { maxSide?: number } = {}) {
  const maxSide = opts.maxSide ?? 256;
  let key = "raw";
  let running = false;
  let busy = false;
  let raf = 0;
  const scratch = document.createElement("canvas");
  const done: number[] = [];
  const stats: LiveStats = { fps: 0, latencyMs: 0, glassToGlassMs: 0, ep: null };
  let listener: ((s: LiveStats) => void) | null = null;
  let hasFrame = false;

  const tick = () => {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    const styleId = styleFor(key);
    if (busy || !styleId || video.readyState < 2 || !video.videoWidth) return;
    busy = true;
    const captured = performance.now();
    getClient()
      .stylizeSource(styleId, video, video.videoWidth, video.videoHeight, maxSide, scratch)
      .then((res) => {
        if (!running || styleFor(key) !== styleId) return;
        canvas.width = res.width;
        canvas.height = res.height;
        canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(res.pixels), res.width, res.height), 0, 0);
        hasFrame = true;
        const now = performance.now();
        done.push(now);
        while (done.length && now - done[0]! > 1000) done.shift();
        stats.fps = done.length;
        stats.latencyMs = Math.round(res.timings.totalMs);
        stats.glassToGlassMs = Math.round(now - captured);
        stats.ep = res.ep;
        listener?.({ ...stats });
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  };

  return {
    setStyle(next: string) {
      if (next !== key) hasFrame = false;
      key = next;
      preload(next);
    },
    start() {
      if (running) return;
      running = true;
      tick();
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    onStats(fn: ((s: LiveStats) => void) | null) {
      listener = fn;
    },
    /** True once a styled frame for the current style has been painted. */
    get ready() {
      return hasFrame && styleFor(key) !== null;
    },
    get stats() {
      return { ...stats };
    },
  };
}

// ------------------------------------------------------------------ auth ---
interface Session {
  email: string;
  access: string;
  refresh: string;
}
const SESSION_KEY = "ns.session";

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
function writeSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // storage unavailable: session lasts for this page only
  }
  memorySession = s;
}
let memorySession: Session | null = readSession();

const auth = {
  user: () => memorySession,
  initials(): string | null {
    const e = memorySession?.email;
    if (!e) return null;
    const name = e.split("@")[0]!.replace(/[^a-z0-9]+/gi, " ").trim();
    const parts = name.split(" ").filter(Boolean);
    return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase() || "?";
  },
  displayName(): string | null {
    const e = memorySession?.email;
    if (!e) return null;
    return e
      .split("@")[0]!
      .split(/[._-]+/)
      .filter(Boolean)
      .map((p) => p[0]!.toUpperCase() + p.slice(1))
      .join(" ");
  },
  logout: () => writeSession(null),
};

// ------------------------------------------------------------------- api ---
export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const OFFLINE = "The StarryNight backend isn't running — start Django (python manage.py runserver) and try again.";

function flattenErrors(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.error === "string") return b.error;
  if (typeof b.detail === "string") return b.detail;
  if (b.error && typeof b.error === "object" && typeof (b.error as { message?: unknown }).message === "string") {
    return (b.error as { message: string }).message;
  }
  const parts: string[] = [];
  for (const v of Object.values(b)) {
    if (Array.isArray(v)) parts.push(...v.map(String));
    else if (typeof v === "string") parts.push(v);
  }
  return parts.length ? parts.join(" ") : null;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (memorySession) headers.set("Authorization", `Bearer ${memorySession.access}`);
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiFailure(OFFLINE, 0);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    // Next's proxy answers 500 with an HTML/empty body when Django is down.
    if (body === null && res.status >= 500) throw new ApiFailure(OFFLINE, res.status);
    if (res.status === 401 && path.includes("/accounts/login/")) throw new ApiFailure("Wrong email or password.", 401);
    throw new ApiFailure(flattenErrors(body) ?? `Request failed (${res.status})`, res.status);
  }
  return body as T;
}

export interface VideoJobStatus {
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  video_url: string | null;
  error: string | null;
  style?: string;
}

const api = {
  async login(email: string, password: string) {
    const tokens = await call<{ access: string; refresh: string }>("/accounts/login/", {
      method: "POST",
      body: JSON.stringify({ username: email.trim(), password }),
    });
    writeSession({ email: email.trim().toLowerCase(), ...tokens });
    return memorySession!;
  },
  async register(email: string, password: string) {
    const e = email.trim().toLowerCase();
    await call("/accounts/register/", {
      method: "POST",
      body: JSON.stringify({ username: e, email: e, password, password_confirm: password, first_name: "", last_name: "" }),
    });
    return api.login(e, password);
  },
  forgot(email: string) {
    return call<{ message: string; uid?: string; token?: string }>("/accounts/forgot-password/", {
      method: "POST",
      body: JSON.stringify({ email: email.trim() }),
    });
  },
  reset(uid: string, token: string, password: string) {
    return call<{ message: string }>("/accounts/reset-password/", {
      method: "POST",
      body: JSON.stringify({ uid, token, password }),
    });
  },
  submitVideo(file: Blob, key: string, source = "upload") {
    const styleId = styleFor(key);
    if (!styleId) return Promise.reject(new ApiFailure(`Unknown style ${key}`, 400));
    const form = new FormData();
    form.append("video", file, (file as File).name || "upload.mp4");
    form.append("style", styleId);
    form.append("source", source);
    return call<{ job_id: string; status: string; execution_mode: string }>("/style_transfer/webcam-video/", {
      method: "POST",
      body: form,
    });
  },
  jobStatus(jobId: string) {
    return call<VideoJobStatus>(`/style_transfer/video-status/${encodeURIComponent(jobId)}/`);
  },
  /** Poll until the job finishes. `onProgress` gets 0–100. Resolves with the video URL. */
  async waitForJob(jobId: string, onProgress: (pct: number, status: string) => void, isCancelled: () => boolean) {
    for (;;) {
      if (isCancelled()) throw new ApiFailure("cancelled", 0);
      const s = await api.jobStatus(jobId);
      const pct = Math.max(0, Math.min(100, Number(s.progress) || 0));
      onProgress(pct, s.status);
      if (s.status === "completed" && s.video_url) return s.video_url;
      if (s.status === "failed") throw new ApiFailure(s.error || "Video processing failed.", 500);
      await new Promise((r) => setTimeout(r, 1200));
    }
  },
};

// --------------------------------------------------------------- gallery ---
/** Persists works the user saves (the design's in-memory list survives reloads). */
const DB_NAME = "neural-style";
const STORE = "works";
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = fn(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const gallery = {
  async load<T extends { savedAt?: number }>(): Promise<T[]> {
    try {
      const all = await tx<T[]>("readonly", (s) => s.getAll() as IDBRequest<T[]>);
      return all.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
    } catch {
      return [];
    }
  },
  async save(work: { id: string }) {
    try {
      await tx("readwrite", (s) => s.put({ ...work, savedAt: Date.now() }));
    } catch {
      // storage unavailable: work stays in memory for this session
    }
  },
  async remove(id: string) {
    try {
      await tx("readwrite", (s) => s.delete(id));
    } catch {
      // ignore
    }
  },
};

const NS = { styleFor, stylizeImage, preload, live, api, auth, gallery, ApiFailure, StyleError };
declare global {
  interface Window {
    NS: typeof NS;
  }
}
window.NS = NS;
export default NS;
