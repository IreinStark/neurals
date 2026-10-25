import { describe, expect, it } from "vitest";
import { simplifyFlatPoints } from "./simplify";

describe("simplifyFlatPoints (RDP)", () => {
  it("collapses collinear points to the endpoints", () => {
    expect(simplifyFlatPoints([0, 0, 1, 1, 2, 2, 3, 3, 4, 4])).toEqual([0, 0, 4, 4]);
  });

  it("keeps corners that deviate more than epsilon", () => {
    expect(simplifyFlatPoints([0, 0, 5, 0.2, 10, 0, 10, 10], 1)).toEqual([0, 0, 10, 0, 10, 10]);
  });

  it("returns short strokes unchanged", () => {
    expect(simplifyFlatPoints([3, 4])).toEqual([3, 4]);
    expect(simplifyFlatPoints([0, 0, 9, 9])).toEqual([0, 0, 9, 9]);
  });

  it("handles thousands of points and reduces a noisy line", () => {
    const pts: number[] = [];
    for (let i = 0; i < 5000; i++) pts.push(i, Math.sin(i) * 0.3);
    const out = simplifyFlatPoints(pts, 1);
    expect(out.length).toBe(4);
  });

  it("rejects odd-length input", () => {
    expect(() => simplifyFlatPoints([1, 2, 3])).toThrow(RangeError);
  });
});
