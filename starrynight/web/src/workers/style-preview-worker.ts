/// <reference lib="webworker" />
/**
 * style-preview-worker (T4.2, ARCHITECTURE_SPEC §8).
 *
 * Runs TransformerNet ONNX models off the main thread with onnxruntime-web.
 *  - Execution provider fallback: webgpu → webgl → wasm (plan risk R4).
 *  - Pixel buffers arrive and leave as transferred ArrayBuffers (zero-copy, risk R1).
 *  - One inference at a time; a newer request for the same style replaces a queued one.
 *  - Sessions cached per style (LRU, max 2) to bound GPU/WASM memory.
 */
import * as ort from "onnxruntime-web/all";
import { ONNX_MODELS, type StyleId } from "@/contracts/styles";
import type { ExecutionProvider, FromWorker, ToWorker } from "@/contracts/worker";
import { DEFAULT_EP_ORDER } from "@/contracts/worker";
import { chwFloat32ToRgba, rgbaToChwFloat32 } from "@/ml/tensor";

declare const self: DedicatedWorkerGlobalScope;

ort.env.wasm.wasmPaths = new URL("./ort/", self.location.href).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
ort.env.logLevel = "error";

interface Loaded {
  session: ort.InferenceSession;
  ep: ExecutionProvider;
}

const MAX_SESSIONS = 2;
const sessions = new Map<StyleId, Promise<Loaded>>();
let preferred: readonly ExecutionProvider[] = DEFAULT_EP_ORDER;

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function available(ep: ExecutionProvider): boolean {
  if (ep === "webgpu") return "gpu" in navigator;
  if (ep === "webgl") return typeof OffscreenCanvas !== "undefined";
  return true;
}

async function createSession(styleId: StyleId, modelUrl: string): Promise<Loaded> {
  const head = await fetch(modelUrl, { method: "HEAD" }).catch(() => null);
  if (!head || !head.ok) throw Object.assign(new Error(`Model not found: ${modelUrl}`), { code: "model_missing" });

  const model = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer());
  const errors: string[] = [];
  for (const ep of preferred) {
    if (!available(ep)) continue;
    try {
      const session = await ort.InferenceSession.create(model, {
        executionProviders: [ep],
        graphOptimizationLevel: "all",
      });
      return { session, ep };
    } catch (err) {
      errors.push(`${ep}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw Object.assign(new Error(`No execution provider could load ${styleId} (${errors.join(" | ")})`), {
    code: "ep_unavailable",
  });
}

function getSession(styleId: StyleId, modelUrl?: string): Promise<Loaded> {
  let p = sessions.get(styleId);
  if (p) {
    // refresh LRU position
    sessions.delete(styleId);
    sessions.set(styleId, p);
    return p;
  }
  p = createSession(styleId, modelUrl ?? ONNX_MODELS[styleId].url);
  p.catch(() => sessions.delete(styleId));
  sessions.set(styleId, p);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as StyleId;
    const old = sessions.get(oldest);
    sessions.delete(oldest);
    void old?.then((l) => l.session.release()).catch(() => undefined);
  }
  return p;
}

type InferMsg = Extract<ToWorker, { type: "infer" }>;
let running = false;
const queue: InferMsg[] = [];

async function runInfer(msg: InferMsg) {
  const t0 = performance.now();
  const spec = ONNX_MODELS[msg.styleId];
  const { session, ep } = await getSession(msg.styleId);
  const { width, height } = msg;
  if (spec.fixedSize && (spec.fixedSize[0] !== height || spec.fixedSize[1] !== width)) {
    throw Object.assign(new Error(`${msg.styleId} requires ${spec.fixedSize[1]}x${spec.fixedSize[0]} input`), {
      code: "internal",
    });
  }
  const rgba = new Uint8ClampedArray(msg.pixels);
  const input = rgbaToChwFloat32(rgba, width, height);
  const t1 = performance.now();

  const feeds: Record<string, ort.Tensor> = {
    [spec.inputName]: new ort.Tensor("float32", input, [1, 3, height, width]),
  };
  const results = await session.run(feeds);
  const out = results[spec.outputName] ?? Object.values(results)[0]!;
  const t2 = performance.now();

  const [, , oh, ow] = out.dims as number[];
  const outW = ow ?? width;
  const outH = oh ?? height;
  const data = (await out.getData()) as Float32Array;
  // Reuse the input buffer for alpha when sizes match; otherwise fully opaque.
  const alpha = outW === width && outH === height ? rgba : 255;
  const pixels = chwFloat32ToRgba(data, outW, outH, alpha);
  out.dispose();
  const t3 = performance.now();

  post(
    {
      type: "result",
      reqId: msg.reqId,
      styleId: msg.styleId,
      width: outW,
      height: outH,
      pixels: pixels.buffer as ArrayBuffer,
      timings: { preMs: t1 - t0, inferMs: t2 - t1, postMs: t3 - t2, totalMs: t3 - t0 },
      ep,
    },
    [pixels.buffer as ArrayBuffer],
  );
}

async function pump() {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  running = true;
  try {
    await runInfer(next);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    post({
      type: "error",
      reqId: next.reqId,
      code: (e.code as "model_missing" | "ep_unavailable" | "internal") ?? "internal",
      message: e.message ?? String(err),
    });
  } finally {
    running = false;
    void pump();
  }
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init": {
      if (msg.preferredEP?.length) preferred = msg.preferredEP;
      const t0 = performance.now();
      getSession(msg.styleId, msg.modelUrl)
        .then(({ ep }) => post({ type: "ready", reqId: msg.reqId, styleId: msg.styleId, ep, loadMs: performance.now() - t0 }))
        .catch((err: { code?: string; message?: string }) =>
          post({
            type: "error",
            reqId: msg.reqId,
            code: (err.code as "model_missing" | "ep_unavailable") ?? "internal",
            message: err.message ?? String(err),
          }),
        );
      return;
    }
    case "infer": {
      // Latest wins: drop queued (not running) requests for the same style.
      for (let i = queue.length - 1; i >= 0; i--) {
        const q = queue[i]!;
        if (q.styleId === msg.styleId) {
          queue.splice(i, 1);
          post({ type: "error", reqId: q.reqId, code: "cancelled", message: "superseded" });
        }
      }
      queue.push(msg);
      void pump();
      return;
    }
    case "cancel": {
      const i = queue.findIndex((q) => q.reqId === msg.reqId);
      if (i !== -1) {
        queue.splice(i, 1);
        post({ type: "error", reqId: msg.reqId, code: "cancelled", message: "cancelled" });
      }
      return;
    }
    case "dispose": {
      const ids = msg.styleId ? [msg.styleId] : [...sessions.keys()];
      for (const id of ids) {
        const p = sessions.get(id);
        sessions.delete(id);
        void p?.then((l) => l.session.release()).catch(() => undefined);
      }
      return;
    }
  }
};
