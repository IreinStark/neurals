/**
 * Typed client for the Django /api/v2 endpoints (ARCHITECTURE_SPEC §7).
 * In the browser, requests go to same-origin /api/v2/* which next.config.ts
 * rewrites to Django, so no CORS setup is needed in development.
 */
import type {
  ApiErrorBody,
  CreateVideoJobResponse,
  HealthResponse,
  StylesResponse,
  VideoJob,
  VideoMode,
} from "@/contracts/api";
import type { StyleId } from "@/contracts/styles";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface DjangoClientOptions {
  /** Base URL; "" means same-origin (browser, via rewrite). */
  baseUrl?: string;
  getAccessToken?: () => Promise<string | null> | string | null;
  fetchImpl?: typeof fetch;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as ApiErrorBody).error?.code === "string"
  );
}

export function createDjangoClient(options: DjangoClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    const token = options.getAccessToken ? await options.getAccessToken() : null;
    if (token) headers.set("Authorization", `Bearer ${token}`);

    const res = await doFetch(`${baseUrl}${path}`, { ...init, headers });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      if (isApiErrorBody(body)) {
        throw new ApiError(res.status, body.error.code, body.error.message, body.error.details);
      }
      throw new ApiError(res.status, "http_error", `Request to ${path} failed with ${res.status}`);
    }
    return body as T;
  }

  return {
    health: () => request<HealthResponse>("/api/v2/health/"),
    styles: () => request<StylesResponse>("/api/v2/styles/"),
    createVideoJob: (input: { video: Blob; styleId: StyleId; mode?: VideoMode; roomId?: string; targetFps?: number }) => {
      const form = new FormData();
      form.append("video", input.video);
      form.append("style_id", input.styleId);
      form.append("mode", input.mode ?? "reconet");
      if (input.roomId) form.append("room_id", input.roomId);
      if (input.targetFps) form.append("target_fps", String(input.targetFps));
      return request<CreateVideoJobResponse>("/api/v2/video/jobs/", { method: "POST", body: form });
    },
    getVideoJob: (jobId: string) => request<VideoJob>(`/api/v2/video/jobs/${encodeURIComponent(jobId)}/`),
  };
}

export type DjangoClient = ReturnType<typeof createDjangoClient>;
