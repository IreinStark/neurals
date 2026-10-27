/**
 * style-preview-worker message protocol (ARCHITECTURE_SPEC §8).
 * Every `pixels` ArrayBuffer is transferred, never copied.
 */
import type { StyleId } from "./styles";

export type ExecutionProvider = "webgpu" | "webgl" | "wasm";

export const DEFAULT_EP_ORDER: readonly ExecutionProvider[] = ["webgpu", "webgl", "wasm"];
export const DEFAULT_MAX_SIDE = 512;
export const WASM_MAX_SIDE = 384;

export type ToWorker =
  | {
      type: "init";
      reqId: string;
      modelUrl: string;
      styleId: StyleId;
      preferredEP?: readonly ExecutionProvider[];
    }
  | {
      type: "infer";
      reqId: string;
      styleId: StyleId;
      width: number;
      height: number;
      /** RGBA Uint8 pixels, transferred. */
      pixels: ArrayBuffer;
      maxSide?: number;
      /** Arbitrary-style models: key of a style image sent earlier with "style". */
      styleKey?: string;
      /** Arbitrary-style models: content↔style blend in [0, 1] (default 1). */
      alpha?: number;
    }
  | {
      /** Register a style image once (cached in the worker by key), e.g. an uploaded painting. */
      type: "style";
      reqId: string;
      key: string;
      width: number;
      height: number;
      /** RGBA Uint8 pixels, transferred. */
      pixels: ArrayBuffer;
    }
  | { type: "cancel"; reqId: string }
  | { type: "dispose"; styleId?: StyleId };

export interface InferTimings {
  preMs: number;
  inferMs: number;
  postMs: number;
  totalMs: number;
}

export type WorkerErrorCode = "model_missing" | "ep_unavailable" | "oom" | "cancelled" | "internal";

export type FromWorker =
  | { type: "ready"; reqId: string; styleId: StyleId; ep: ExecutionProvider; loadMs: number }
  | { type: "styleReady"; reqId: string; key: string }
  | {
      type: "result";
      reqId: string;
      styleId: StyleId;
      width: number;
      height: number;
      /** RGBA Uint8 pixels, transferred. */
      pixels: ArrayBuffer;
      timings: InferTimings;
      ep: ExecutionProvider;
    }
  | { type: "error"; reqId: string; code: WorkerErrorCode; message: string };
