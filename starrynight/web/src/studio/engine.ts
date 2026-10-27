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

/** Cheap content hash for cache keys (FNV-1a over the string). */
function hashString(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + str.length.toString(36);
}

async function dataUrlToBlob(src: string): Promise<Blob> {
  return (await fetch(src)).blob();
}

export interface CustomStyleResult extends ImageStyleResult {
  /** "browser" = AdaIN ONNX in the worker; "server" = Django /api/v2/adain/image/. */
  where: "browser" | "server";
}

const customCache = new Map<string, Promise<CustomStyleResult>>();

/**
 * Arbitrary style transfer (AdaIN): apply ANY style image to the content.
 * Runs in the browser; if the model can't run there, falls back to the Django endpoint.
 */
function stylizeCustom(contentSrc: string, styleSrc: string, alpha = 1, maxSide = 512): Promise<CustomStyleResult> {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 100) / 100;
  const styleKey = `style-${hashString(styleSrc)}`;
  const cacheKey = `${hashString(contentSrc)}|${styleKey}|${a}|${maxSide}`;
  let p = customCache.get(cacheKey);
  if (!p) {
    p = (async (): Promise<CustomStyleResult> => {
      try {
        const [img, styleImg] = await Promise.all([loadImage(contentSrc), loadImage(styleSrc)]);
        const c = getClient();
        if (!c.hasStyle(styleKey)) await c.setStyleImage(styleKey, styleImg, styleImg.naturalWidth, styleImg.naturalHeight);
        const res = await c.stylizeSource("adain", img, img.naturalWidth, img.naturalHeight, maxSide, undefined, {
          styleKey,
          alpha: a,
        });
        const canvas = toCanvas(res);
        return {
          dataUrl: canvas.toDataURL("image/jpeg", 0.92),
          ms: Math.round(res.timings.totalMs),
          ep: res.ep,
          width: res.width,
          height: res.height,
          where: "browser",
        };
      } catch (browserErr) {
        try {
          const r = await api.adainImage(await dataUrlToBlob(contentSrc), await dataUrlToBlob(styleSrc), a, maxSide);
          return { dataUrl: r.image, ms: Math.round(r.ms), ep: "wasm", width: r.width, height: r.height, where: "server" };
        } catch (serverErr) {
          throw serverErr instanceof ApiFailure && serverErr.status !== 0 ? serverErr : browserErr;
        }
      }
    })();
    p.catch(() => customCache.delete(cacheKey));
    customCache.set(cacheKey, p);
    while (customCache.size > 24) customCache.delete(customCache.keys().next().value as string);
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

/** Access tokens live 5 minutes; swap the refresh token for a new one (once, shared by concurrent calls). */
let refreshing: Promise<boolean> | null = null;
function refreshAccess(): Promise<boolean> {
  const s = memorySession;
  if (!s?.refresh) return Promise.resolve(false);
  refreshing ??= fetch("/accounts/login/refresh/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refresh: s.refresh }),
  })
    .then(async (r) => {
      if (!r.ok) {
        if (r.status === 401) writeSession(null); // refresh token expired: signed out
        return false;
      }
      const t = (await r.json()) as { access: string; refresh?: string };
      writeSession({ ...s, access: t.access, refresh: t.refresh ?? s.refresh });
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

async function call<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
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
  if (res.status === 401 && !retried && memorySession && !path.includes("/accounts/login/") && (await refreshAccess())) {
    return call<T>(path, init, true);
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
  /** Server-side AdaIN on one image (content + style). */
  adainImage(content: Blob, style: Blob, alpha = 1, maxSide = 768) {
    const form = new FormData();
    form.append("content", content, "content.jpg");
    form.append("style", style, "style.jpg");
    form.append("alpha", String(alpha));
    form.append("max_side", String(maxSide));
    return call<{ image: string; width: number; height: number; ms: number; alpha: number }>("/api/v2/adain/image/", {
      method: "POST",
      body: form,
    });
  },
  /** Server-side AdaIN video job with an uploaded style image. Progress via jobStatus(). */
  async submitAdainVideo(file: Blob, styleSrc: string | Blob, alpha = 1, source = "upload") {
    const style = typeof styleSrc === "string" ? await dataUrlToBlob(styleSrc) : styleSrc;
    const form = new FormData();
    form.append("video", file, (file as File).name || "upload.mp4");
    form.append("style", style, "style.jpg");
    form.append("alpha", String(Math.max(0, Math.min(1, alpha))));
    form.append("source", source);
    return call<{ job_id: string; status: string; execution_mode: string }>("/api/v2/adain/video/", {
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
/**
 * The design's gallery list (`W` in the page). Signed in → stored on the server (Django `Artwork`, cloud/disk
 * storage, likes, views, public share links). Signed out → IndexedDB in this browser; those works are
 * uploaded automatically the next time the gallery loads while signed in.
 */
export interface Work {
  id: string;
  t: string;
  s: string;
  type: "image" | "video" | "webcam";
  ic?: string;
  pill?: string;
  likes: number;
  views: number;
  fav: boolean;
  age?: string;
  src?: string;
  video?: string;
  vid?: Blob;
  pre?: boolean;
  dur?: string;
  savedAt?: number;
  k?: string;
  sid?: number; // server id
  token?: string | null; // share token
  liked?: boolean; // like state the server last confirmed
}
interface ServerWork {
  id: number;
  title: string;
  kind: Work["type"];
  style: string;
  media_url: string;
  poster_url: string | null;
  duration: string;
  likes: number;
  views: number;
  liked?: boolean;
  created_at: string;
  client_id?: string;
  share_token?: string | null;
  owner?: { name: string };
}
export interface GalleryStats {
  works: number;
  views: number;
  favorites: number;
  used_bytes: number;
  quota_bytes: number;
}

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
const local = {
  async all(): Promise<Work[]> {
    try {
      return await tx<Work[]>("readonly", (s) => s.getAll() as IDBRequest<Work[]>);
    } catch {
      return [];
    }
  },
  async put(w: Work) {
    try {
      const rest: Partial<Work> = { ...w, savedAt: w.savedAt ?? Date.now() };
      delete rest.sid; // server fields don't belong in the offline copy
      delete rest.token;
      delete rest.liked;
      await tx("readwrite", (s) => s.put(rest));
    } catch {
      // storage unavailable: work stays in memory for this session
    }
  },
  async del(id: string) {
    try {
      await tx("readwrite", (s) => s.delete(id));
    } catch {
      // ignore
    }
  },
};

const KIND_UI: Record<Work["type"], { ic: string; pill: string }> = {
  image: { ic: "brush", pill: "Image" },
  video: { ic: "movie", pill: "Video" },
  webcam: { ic: "videocam", pill: "Webcam" },
};

function fromServer(a: ServerWork): Work {
  const isImage = a.kind === "image";
  return {
    id: a.client_id || `a${a.id}`,
    sid: a.id,
    t: a.title,
    s: a.style || "starry",
    type: a.kind,
    ...KIND_UI[a.kind],
    likes: a.likes,
    views: a.views,
    fav: !!a.liked,
    liked: !!a.liked,
    age: new Date(a.created_at).toLocaleDateString(),
    src: (isImage ? a.media_url : a.poster_url) ?? a.media_url,
    video: isImage ? undefined : a.media_url,
    pre: true,
    dur: a.duration || undefined,
    savedAt: Date.parse(a.created_at),
    token: a.share_token ?? null,
  };
}

async function toBlob(src: string): Promise<Blob> {
  return src.startsWith("data:") ? dataUrlToBlob(src) : (await fetch(src)).blob();
}

/** id → server copy, so remove(id) / share() can find the server record the page doesn't know about. */
const known = new Map<string, Work>();
let owner: string | null = null;

async function upload(w: Work): Promise<Work> {
  const form = new FormData();
  const isImage = w.type === "image";
  const media = w.vid ?? (isImage && w.src ? await toBlob(w.src) : null);
  if (!media) throw new ApiFailure("Nothing to upload for this work.", 400);
  const ext = media.type.includes("webm") ? "webm" : media.type.includes("mp4") ? "mp4" : media.type.includes("png") ? "png" : "jpg";
  form.append("media", media, `work.${ext}`);
  if (!isImage && w.src?.startsWith("data:")) form.append("poster", await dataUrlToBlob(w.src), "poster.jpg");
  form.append("kind", w.type);
  form.append("title", w.t);
  form.append("style", w.s ?? "");
  if (w.dur) form.append("duration", w.dur);
  form.append("client_id", w.id);
  return fromServer(await call<ServerWork>("/api/v2/gallery/", { method: "POST", body: form }));
}

const gallery = {
  stats: null as GalleryStats | null,
  /** Whose gallery `load()` last returned ("" = this browser only). */
  get owner() {
    return owner;
  },
  async load(): Promise<Work[]> {
    const email = memorySession?.email ?? "";
    owner = email;
    const offline = (await local.all()).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
    if (!email) {
      gallery.stats = null;
      return offline;
    }
    // works saved while signed out (or when the server was unreachable) move to the account
    for (const w of offline) {
      try {
        await upload(w);
        await local.del(w.id);
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 413) break; // quota full: keep them local
      }
    }
    try {
      const res = await call<{ works: ServerWork[]; stats: GalleryStats }>("/api/v2/gallery/");
      gallery.stats = res.stats;
      known.clear();
      const works = res.works.map(fromServer);
      works.forEach((w) => known.set(w.id, w));
      const pending = (await local.all()).filter((w) => !known.has(w.id));
      return [...pending, ...works];
    } catch {
      return offline; // backend down: show what this browser has
    }
  },
  /** Called by the page after saving or liking a work. Mutates `w` with the server's answer. */
  async save(w: Work): Promise<Work> {
    if (!memorySession) {
      await local.put(w);
      return w;
    }
    try {
      const prev = w.sid ? w : known.get(w.id);
      if (!prev?.sid) {
        const saved = await upload(w);
        Object.assign(w, { sid: saved.sid, token: saved.token, liked: false, video: saved.video ?? w.video });
        known.set(w.id, w);
        void refreshStats();
      }
      if (w.sid && w.fav !== !!w.liked) {
        const r = await call<{ liked: boolean; likes: number }>(`/api/v2/gallery/${w.sid}/like/`, { method: "POST" });
        Object.assign(w, { liked: r.liked, fav: r.liked, likes: r.likes });
      }
    } catch (e) {
      if (!w.sid) await local.put(w); // keep it; uploaded on the next load
      window.dispatchEvent(new CustomEvent("ns:gallery-error", { detail: e instanceof Error ? e.message : String(e) }));
    }
    return w;
  },
  async remove(id: string) {
    await local.del(id);
    const w = known.get(id);
    if (w?.sid && memorySession) {
      known.delete(id);
      try {
        await call(`/api/v2/gallery/${w.sid}/`, { method: "DELETE" });
      } catch (e) {
        window.dispatchEvent(new CustomEvent("ns:gallery-error", { detail: e instanceof Error ? e.message : String(e) }));
      }
      void refreshStats();
    }
  },
  /** Public link for a work (uploads it first if needed). Needs an account. */
  async share(w: Work): Promise<string> {
    if (!memorySession) throw new ApiFailure("Sign in to share your work.", 401);
    if (!w.sid) {
      const k = known.get(w.id);
      if (k?.sid) w.sid = k.sid;
      else Object.assign(w, await upload(w), { id: w.id, src: w.src });
      known.set(w.id, w);
    }
    const r = await call<{ token: string }>(`/api/v2/gallery/${w.sid}/share/`, { method: "POST" });
    w.token = r.token;
    return `${location.origin}/s/${r.token}/`;
  },
  async unshare(w: Work) {
    if (w.sid) await call(`/api/v2/gallery/${w.sid}/share/`, { method: "DELETE" });
    w.token = null;
  },
  /** A work someone shared (public, no login). null if the link was removed. */
  async shared(token: string): Promise<(Work & { by?: string }) | null> {
    try {
      const a = await call<ServerWork>(`/api/v2/share/${encodeURIComponent(token)}/`);
      return { ...fromServer(a), id: token, by: a.owner?.name };
    } catch {
      return null;
    }
  },
};

async function refreshStats() {
  try {
    gallery.stats = (await call<{ stats: GalleryStats }>("/api/v2/gallery/?sort=newest")).stats;
  } catch {
    // keep the last numbers
  }
}

const NS = { styleFor, stylizeImage, stylizeCustom, preload, live, api, auth, gallery, ApiFailure, StyleError };
declare global {
  interface Window {
    NS: typeof NS;
  }
}
window.NS = NS;
export default NS;
