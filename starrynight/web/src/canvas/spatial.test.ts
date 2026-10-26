import { describe, expect, it } from "vitest";
import type { BoardNode } from "@/contracts/board";
import { SpatialGrid, getNodeBounds } from "./spatial";

const base = { rotation: 0, scaleX: 1, scaleY: 1, createdBy: "u", createdAt: 0, updatedAt: 0 };
const rect = (id: string, x: number, y: number, w = 100, h = 50): BoardNode => ({
  ...base,
  id,
  type: "rect",
  x,
  y,
  width: w,
  height: h,
  fill: "#fff",
  stroke: "#000",
  strokeWidth: 1,
});

describe("getNodeBounds", () => {
  it("handles boxes, scale and rotation", () => {
    expect(getNodeBounds(rect("a", 10, 20))).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    const scaled = { ...rect("b", 0, 0), scaleX: 2 } as BoardNode;
    expect(getNodeBounds(scaled).width).toBe(200);
    const rotated = getNodeBounds({ ...rect("c", 0, 0, 100, 100), rotation: 90 } as BoardNode);
    expect(rotated.x).toBeCloseTo(-100);
    expect(rotated.width).toBeCloseTo(100);
  });

  it("centres ellipses and pads strokes by half their width", () => {
    const ell = { ...rect("e", 50, 50, 40, 20), type: "ellipse" } as BoardNode;
    expect(getNodeBounds(ell)).toEqual({ x: 30, y: 40, width: 40, height: 20 });
    const stroke: BoardNode = { ...base, id: "s", type: "stroke", x: 100, y: 100, points: [0, 0, 10, 20], color: "#000", width: 4, opacity: 1 };
    expect(getNodeBounds(stroke)).toEqual({ x: 98, y: 98, width: 14, height: 24 });
  });
});

describe("SpatialGrid", () => {
  it("returns only nodes intersecting the query", () => {
    const g = new SpatialGrid(256);
    g.reset([rect("near", 0, 0), rect("far", 5000, 5000), rect("edge", 790, 0)]);
    expect([...g.query({ x: 0, y: 0, width: 800, height: 600 })].sort()).toEqual(["edge", "near"]);
  });

  it("supports update, removal and containment queries", () => {
    const g = new SpatialGrid(100);
    g.upsert("a", { x: 0, y: 0, width: 50, height: 50 });
    g.upsert("b", { x: 40, y: 40, width: 100, height: 100 });
    expect([...g.queryContained({ x: -10, y: -10, width: 80, height: 80 })]).toEqual(["a"]);
    g.upsert("a", { x: 1000, y: 1000, width: 10, height: 10 });
    expect(g.query({ x: 0, y: 0, width: 60, height: 60 }).has("a")).toBe(false);
    g.remove("b");
    expect(g.size).toBe(1);
    expect(g.totalBounds()).toEqual({ x: 1000, y: 1000, width: 10, height: 10 });
  });

  it("culls a 2000-node board to the visible set quickly", () => {
    const g = new SpatialGrid();
    const nodes: BoardNode[] = [];
    for (let i = 0; i < 2000; i++) nodes.push(rect(`n${i}`, (i % 50) * 300, Math.floor(i / 50) * 300));
    g.reset(nodes);
    const start = performance.now();
    const visible = g.query({ x: 0, y: 0, width: 1200, height: 900 });
    expect(performance.now() - start).toBeLessThan(5);
    expect(visible.size).toBe(20); // columns x=0..1200 (5, edges inclusive) x rows y=0..900 (4)
  });
});
