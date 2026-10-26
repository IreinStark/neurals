/**
 * Spatial indexing for viewport culling and marquee selection (T3.1).
 * A uniform grid hash: each node is registered in every cell its bounding box touches.
 * Queries visit only the cells overlapping the query rectangle, so render cost scales
 * with what is on screen rather than with the size of the board.
 */
import type { BoardNode } from "@/contracts/board";
import { rectsIntersect, type Rect } from "./viewport";

/** Axis-aligned world-space bounds, accounting for scale and rotation. */
export function getNodeBounds(node: BoardNode): Rect {
  let local: Rect;
  switch (node.type) {
    case "stroke":
    case "arrow": {
      const pts = node.points;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const px = pts[i]!;
        const py = pts[i + 1]!;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      if (minX === Infinity) {
        minX = maxX = 0;
        minY = maxY = 0;
      }
      const pad = (node.type === "stroke" ? node.width : node.strokeWidth * 3) / 2;
      local = { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
      break;
    }
    case "ellipse":
      // Konva ellipses are centred on (x, y).
      local = { x: -node.width / 2, y: -node.height / 2, width: node.width, height: node.height };
      break;
    default:
      local = { x: 0, y: 0, width: node.width, height: node.height };
  }

  const sx = node.scaleX ?? 1;
  const sy = node.scaleY ?? 1;
  const corners = [
    [local.x, local.y],
    [local.x + local.width, local.y],
    [local.x, local.y + local.height],
    [local.x + local.width, local.y + local.height],
  ] as const;
  const rad = ((node.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [cx, cy] of corners) {
    const x = node.x + cx * sx * cos - cy * sy * sin;
    const y = node.y + cx * sx * sin + cy * sy * cos;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export class SpatialGrid {
  private readonly cells = new Map<string, Set<string>>();
  private readonly entries = new Map<string, { bounds: Rect; keys: string[] }>();

  constructor(readonly cellSize = 512) {}

  get size(): number {
    return this.entries.size;
  }

  private keysFor(r: Rect): string[] {
    const s = this.cellSize;
    const x0 = Math.floor(r.x / s);
    const y0 = Math.floor(r.y / s);
    const x1 = Math.floor((r.x + r.width) / s);
    const y1 = Math.floor((r.y + r.height) / s);
    const keys: string[] = [];
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) keys.push(`${cx}:${cy}`);
    return keys;
  }

  upsert(id: string, bounds: Rect): void {
    this.remove(id);
    const keys = this.keysFor(bounds);
    for (const k of keys) {
      let cell = this.cells.get(k);
      if (!cell) this.cells.set(k, (cell = new Set()));
      cell.add(id);
    }
    this.entries.set(id, { bounds, keys });
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const k of entry.keys) {
      const cell = this.cells.get(k);
      cell?.delete(id);
      if (cell && cell.size === 0) this.cells.delete(k);
    }
    this.entries.delete(id);
  }

  /** Ids whose bounds intersect `rect`. */
  query(rect: Rect): Set<string> {
    const out = new Set<string>();
    for (const k of this.keysFor(rect)) {
      const cell = this.cells.get(k);
      if (!cell) continue;
      for (const id of cell) {
        if (out.has(id)) continue;
        const entry = this.entries.get(id);
        if (entry && rectsIntersect(entry.bounds, rect)) out.add(id);
      }
    }
    return out;
  }

  /** Ids fully contained in `rect` (marquee selection). */
  queryContained(rect: Rect): Set<string> {
    const out = new Set<string>();
    for (const id of this.query(rect)) {
      const b = this.entries.get(id)!.bounds;
      if (b.x >= rect.x && b.y >= rect.y && b.x + b.width <= rect.x + rect.width && b.y + b.height <= rect.y + rect.height) {
        out.add(id);
      }
    }
    return out;
  }

  /** Rebuild from scratch, reusing nothing (cheap for hundreds of nodes). */
  reset(nodes: readonly BoardNode[]): void {
    this.cells.clear();
    this.entries.clear();
    for (const n of nodes) this.upsert(n.id, getNodeBounds(n));
  }

  boundsOf(id: string): Rect | undefined {
    return this.entries.get(id)?.bounds;
  }

  /** Union of all bounds, or null for an empty board. */
  totalBounds(): Rect | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const { bounds: b } of this.entries.values()) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    }
    return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
}
