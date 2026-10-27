import { beforeAll, describe, expect, it } from "vitest";
import type { FromWorker, ToWorker } from "@/contracts/worker";
import { StyleClient, StyleError, type WorkerLike } from "./styleClient";

/** Fake worker that answers like the real one: inverts pixels, echoes size. */
class FakeWorker implements WorkerLike {
  listeners: Array<(e: MessageEvent<FromWorker>) => void> = [];
  sent: Array<{ msg: ToWorker; transfer?: Transferable[] }> = [];
  failInit = false;

  addEventListener(_t: "message", l: (e: MessageEvent<FromWorker>) => void) {
    this.listeners.push(l);
  }
  terminate() {}
  private reply(msg: FromWorker) {
    queueMicrotask(() => this.listeners.forEach((l) => l({ data: msg } as MessageEvent<FromWorker>)));
  }
  postMessage(msg: ToWorker, transfer?: Transferable[]) {
    this.sent.push({ msg, transfer });
    if (msg.type === "init") {
      if (this.failInit) this.reply({ type: "error", reqId: msg.reqId, code: "model_missing", message: "404" });
      else this.reply({ type: "ready", reqId: msg.reqId, styleId: msg.styleId, ep: "wasm", loadMs: 1 });
    } else if (msg.type === "style") {
      this.reply({ type: "styleReady", reqId: msg.reqId, key: msg.key });
    } else if (msg.type === "infer") {
      const px = new Uint8ClampedArray(msg.pixels).map((v, i) => (i % 4 === 3 ? v : 255 - v));
      this.reply({
        type: "result",
        reqId: msg.reqId,
        styleId: msg.styleId,
        width: msg.width,
        height: msg.height,
        pixels: px.buffer,
        timings: { preMs: 1, inferMs: 2, postMs: 1, totalMs: 4 },
        ep: "wasm",
      });
    }
  }
}

/** jsdom has no OffscreenCanvas; a minimal stand-in that returns blank pixels. */
class OffscreenCanvasStub {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return {
      drawImage: () => undefined,
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    };
  }
}

describe("StyleClient", () => {
  beforeAll(() => {
    (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = OffscreenCanvasStub;
  });

  it("initialises a style once and reports the execution provider", async () => {
    const w = new FakeWorker();
    const client = new StyleClient(w);
    await Promise.all([client.init("mosaic"), client.init("mosaic")]);
    expect(w.sent.filter((s) => s.msg.type === "init")).toHaveLength(1);
    expect(w.sent[0]!.msg).toMatchObject({ modelUrl: "/models/mosaic.onnx" });
    expect(client.lastEp).toBe("wasm");
  });

  it("transfers the pixel buffer (zero-copy) and returns the result", async () => {
    const w = new FakeWorker();
    const client = new StyleClient(w);
    const pixels = new Uint8ClampedArray([10, 20, 30, 255]);
    const res = await client.stylizePixels("udnie", pixels, 1, 1);
    const infer = w.sent.find((s) => s.msg.type === "infer")!;
    expect(infer.transfer?.[0]).toBe(pixels.buffer);
    expect(Array.from(res.pixels)).toEqual([245, 235, 225, 255]);
    expect(res.timings.totalMs).toBe(4);
  });

  it("sends an AdaIN style image once and references it by key", async () => {
    const w = new FakeWorker();
    const client = new StyleClient(w);
    const style = new OffscreenCanvasStub(40, 30) as unknown as CanvasImageSource;
    await client.setStyleImage("painting-1", style, 40, 30);
    expect(client.hasStyle("painting-1")).toBe(true);
    const styleMsg = w.sent.find((s) => s.msg.type === "style")!;
    expect(styleMsg.msg).toMatchObject({ key: "painting-1", width: 40, height: 24 }); // snapped to multiples of 8
    expect(styleMsg.transfer).toHaveLength(1);

    await client.stylizePixels("adain", new Uint8ClampedArray(4), 1, 1, { styleKey: "painting-1", alpha: 0.6 });
    expect(w.sent.find((s) => s.msg.type === "infer")!.msg).toMatchObject({ styleKey: "painting-1", alpha: 0.6 });
  });

  it("rejects with the worker's error code and retries init next time", async () => {
    const w = new FakeWorker();
    w.failInit = true;
    const client = new StyleClient(w);
    await expect(client.init("wave")).rejects.toMatchObject({ code: "model_missing" });
    await expect(client.init("wave")).rejects.toBeInstanceOf(StyleError);
    expect(w.sent.filter((s) => s.msg.type === "init")).toHaveLength(2);
  });
});
