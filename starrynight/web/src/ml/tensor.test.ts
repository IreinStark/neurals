import { describe, expect, it } from "vitest";
import { chwFloat32ToRgba, fitWithin, rgbaToChwFloat32 } from "./tensor";

describe("rgbaToChwFloat32 (TC-UNT-01 tensor contract)", () => {
  it("produces [3, H, W] planar RGB in 0–255 and drops alpha", () => {
    // 2x1 image: red pixel, then semi-transparent blue pixel
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 128]);
    const t = rgbaToChwFloat32(rgba, 2, 1);
    expect(t).toBeInstanceOf(Float32Array);
    expect(Array.from(t)).toEqual([255, 0, 0, 0, 0, 255]);
  });

  it("rejects buffers whose size does not match H x W x 4", () => {
    expect(() => rgbaToChwFloat32(new Uint8ClampedArray(10), 2, 2)).toThrow(RangeError);
  });

  it("pre-processes a 512x512 frame within 15 ms", () => {
    const w = 512;
    const h = 512;
    const rgba = new Uint8ClampedArray(w * h * 4).map((_, i) => i % 256);
    const out = new Float32Array(w * h * 3);
    rgbaToChwFloat32(rgba, w, h, out); // warm-up (JIT)
    const runs = 5;
    const start = performance.now();
    for (let i = 0; i < runs; i++) rgbaToChwFloat32(rgba, w, h, out);
    const avg = (performance.now() - start) / runs;
    expect(avg).toBeLessThanOrEqual(15);
  });
});

describe("chwFloat32ToRgba", () => {
  it("clamps model output into 0–255 and restores alpha", () => {
    const tensor = new Float32Array([-60, 390, 12.6, 128, 0, 255]); // 2x1, R plane, G plane, B plane
    const alpha = new Uint8ClampedArray([0, 0, 0, 200, 0, 0, 0, 50]);
    const rgba = chwFloat32ToRgba(tensor, 2, 1, alpha);
    expect(Array.from(rgba)).toEqual([0, 13, 0, 200, 255, 128, 255, 50]);
  });

  it("round-trips through rgbaToChwFloat32", () => {
    const rgba = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
    expect(Array.from(chwFloat32ToRgba(rgbaToChwFloat32(rgba, 2, 2), 2, 2))).toEqual(Array.from(rgba));
  });
});

describe("fitWithin", () => {
  it("never upscales and snaps to multiples of 4", () => {
    expect(fitWithin(300, 201, 512)).toEqual({ width: 300, height: 200 });
  });

  it("snaps to a custom multiple (AdaIN needs multiples of 8)", () => {
    expect(fitWithin(979, 734, 512, 8)).toEqual({ width: 512, height: 376 });
  });

  it("scales the long side down to maxSide keeping aspect ratio", () => {
    expect(fitWithin(1920, 1080, 512)).toEqual({ width: 512, height: 288 });
  });
});
