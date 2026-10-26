/**
 * Main-thread client for style-preview-worker (T4.2). Turns the message protocol into
 * promises, resizes inputs on the main thread's canvas (GPU-accelerated drawImage) and
 * transfers pixel buffers zero-copy in both directions.
 */
import { ONNX_MODELS, type StyleId } from "@/contracts/styles";
import {
  DEFAULT_MAX_SIDE,
  type ExecutionProvider,
  type FromWorker,
  type InferTimings,
  type ToWorker,
} from "@/contracts/worker";
import { fitWithin } from "./tensor";

export interface StyleResult {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  timings: InferTimings;
  ep: ExecutionProvider;
}

export class StyleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StyleError";
  }
}

/** Minimal Worker surface so tests can inject a fake. */
export interface WorkerLike {
  postMessage(message: ToWorker, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (e: MessageEvent<FromWorker>) => void): void;
  terminate(): void;
}

type Pending = { resolve: (v: FromWorker) => void; reject: (e: StyleError) => void };

export class StyleClient {
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly ready = new Map<StyleId, Promise<ExecutionProvider>>();
  lastEp: ExecutionProvider | null = null;

  constructor(private readonly worker: WorkerLike) {
    worker.addEventListener("message", (e) => {
      const msg = e.data;
      if (msg.type !== "ready" && msg.type !== "result" && msg.type !== "error") return;
      const p = this.pending.get(msg.reqId);
      if (!p) return;
      this.pending.delete(msg.reqId);
      if (msg.type === "error") p.reject(new StyleError(msg.code, msg.message));
      else p.resolve(msg);
    });
  }

  private request(msg: ToWorker & { reqId: string }, transfer: Transferable[] = []): Promise<FromWorker> {
    return new Promise((resolve, reject) => {
      this.pending.set(msg.reqId, { resolve, reject });
      this.worker.postMessage(msg, transfer);
    });
  }

  private nextId() {
    return `r${++this.seq}`;
  }

  /** Load (and cache) a style's session. Safe to call repeatedly. */
  init(styleId: StyleId): Promise<ExecutionProvider> {
    let p = this.ready.get(styleId);
    if (!p) {
      p = this.request({ type: "init", reqId: this.nextId(), styleId, modelUrl: ONNX_MODELS[styleId].url }).then(
        (m) => {
          if (m.type !== "ready") throw new StyleError("internal", "unexpected reply");
          this.lastEp = m.ep;
          return m.ep;
        },
      );
      p.catch(() => this.ready.delete(styleId));
      this.ready.set(styleId, p);
    }
    return p;
  }

  /** Stylize raw RGBA pixels (already at inference size). The buffer is transferred. */
  async stylizePixels(styleId: StyleId, pixels: Uint8ClampedArray, width: number, height: number): Promise<StyleResult> {
    await this.init(styleId);
    const buffer = pixels.buffer as ArrayBuffer;
    const msg = await this.request(
      { type: "infer", reqId: this.nextId(), styleId, width, height, pixels: buffer },
      [buffer],
    );
    if (msg.type !== "result") throw new StyleError("internal", "unexpected reply");
    this.lastEp = msg.ep;
    return {
      width: msg.width,
      height: msg.height,
      pixels: new Uint8ClampedArray(msg.pixels),
      timings: msg.timings,
      ep: msg.ep,
    };
  }

  /**
   * Stylize any drawable (image, video frame, canvas). Draws it at inference size
   * (`maxSide`, multiples of 4; fixed-size models get their exact size).
   */
  async stylizeSource(
    styleId: StyleId,
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    maxSide = DEFAULT_MAX_SIDE,
    scratch?: HTMLCanvasElement | OffscreenCanvas,
  ): Promise<StyleResult> {
    const fixed = ONNX_MODELS[styleId].fixedSize;
    const { width, height } = fixed ? { width: fixed[1], height: fixed[0] } : fitWithin(sourceWidth, sourceHeight, maxSide);
    const canvas = scratch ?? new OffscreenCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) throw new StyleError("internal", "2D canvas unavailable");
    ctx.drawImage(source, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    return this.stylizePixels(styleId, data, width, height);
  }

  dispose() {
    for (const p of this.pending.values()) p.reject(new StyleError("cancelled", "client disposed"));
    this.pending.clear();
    this.worker.postMessage({ type: "dispose" });
    this.worker.terminate();
  }
}

/** Paint a result onto a canvas (resizing the canvas to the result). */
export function resultToCanvas(result: StyleResult, canvas: HTMLCanvasElement): HTMLCanvasElement {
  canvas.width = result.width;
  canvas.height = result.height;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.putImageData(new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height), 0, 0);
  return canvas;
}
