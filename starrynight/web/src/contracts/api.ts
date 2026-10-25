/**
 * Django /api/v2 REST contracts (ARCHITECTURE_SPEC §7).
 */
import type { StyleId } from "./styles";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export interface StyleInfo {
  id: StyleId;
  label: string;
  serverAvailable: boolean;
  onnx: string | null;
}

export interface StylesResponse {
  styles: StyleInfo[];
}

export interface HealthResponse {
  status: "ok";
  service: "starrynight-backend";
  api: "v2";
}

export type VideoMode = "reconet" | "per-frame";
export type JobStatus = "queued" | "processing" | "completed" | "failed";

export interface CreateVideoJobResponse {
  job_id: string;
  status: JobStatus;
  execution_mode: "celery" | "thread";
}

export interface VideoJob {
  job_id: string;
  status: JobStatus;
  progress: number;
  output_url: string | null;
  error: string | null;
  metrics: { fps?: number; twe?: number } | null;
}

export interface EvalRow {
  style_id: StyleId;
  mode: VideoMode;
  fps: number;
  psnr: number | null;
  mae: number | null;
  lpips: number | null;
  twe: number | null;
}

export interface EvalRun {
  status: JobStatus;
  rows: EvalRow[];
  report_url: string | null;
}
