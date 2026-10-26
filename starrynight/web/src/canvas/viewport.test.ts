import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  fitRect,
  normalizeRect,
  rectsIntersect,
  screenToWorld,
  visibleWorldRect,
  wheelZoomFactor,
  worldToScreen,
  zoomAt,
} from "./viewport";

describe("viewport transform", () => {
  const v = { x: 100, y: -50, scale: 2 };

  it("round-trips screen <-> world", () => {
    const p = { x: 37, y: 91 };
    const back = worldToScreen(v, screenToWorld(v, p));
    expect(back.x).toBeCloseTo(37);
    expect(back.y).toBeCloseTo(91);
  });

  it("keeps the anchor point fixed while zooming", () => {
    const anchor = { x: 400, y: 300 };
    const before = screenToWorld(v, anchor);
    const after = screenToWorld(zoomAt(v, anchor, 1.7), anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps zoom to [MIN_SCALE, MAX_SCALE]", () => {
    expect(zoomAt(v, { x: 0, y: 0 }, 1000).scale).toBe(MAX_SCALE);
    expect(zoomAt(v, { x: 0, y: 0 }, 0.0001).scale).toBe(MIN_SCALE);
  });

  it("computes the visible world rectangle", () => {
    const r = visibleWorldRect({ x: 0, y: 0, scale: 2 }, 800, 600);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(0);
    expect(r.width).toBe(400);
    expect(r.height).toBe(300);
    expect(visibleWorldRect({ x: -200, y: 0, scale: 1 }, 800, 600)).toMatchObject({ x: 200, y: 0 });
  });

  it("maps wheel deltas to a bounded zoom factor", () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
    expect(wheelZoomFactor(10_000)).toBeCloseTo(wheelZoomFactor(50));
  });

  it("fits a rectangle into the screen", () => {
    const fit = fitRect({ x: 1000, y: 1000, width: 400, height: 200 }, 848, 448, 24);
    const tl = worldToScreen(fit, { x: 1000, y: 1000 });
    expect(fit.scale).toBeCloseTo(2);
    expect(tl.x).toBeCloseTo(24);
    expect(tl.y).toBeCloseTo(24);
  });
});

describe("rect helpers", () => {
  it("normalises rectangles drawn from any corner", () => {
    expect(normalizeRect({ x: 10, y: 10, width: -4, height: -6 })).toEqual({ x: 6, y: 4, width: 4, height: 6 });
  });

  it("detects intersection including touching edges", () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 10, width: 5, height: 5 })).toBe(true);
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 11, y: 0, width: 5, height: 5 })).toBe(false);
  });
});
