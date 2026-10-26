/**
 * Infinite-canvas viewport math (T3.1). The viewport is an affine transform
 * world -> screen:  screen = world * scale + (x, y).
 */
export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;
export const IDENTITY: Viewport = { x: 0, y: 0, scale: 1 };

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function screenToWorld(v: Viewport, p: Point): Point {
  // "+ 0" turns -0 into 0 so results compare cleanly.
  return { x: (p.x - v.x) / v.scale + 0, y: (p.y - v.y) / v.scale + 0 };
}

export function worldToScreen(v: Viewport, p: Point): Point {
  return { x: p.x * v.scale + v.x, y: p.y * v.scale + v.y };
}

/** Zoom by `factor` keeping the world point under `anchor` (screen coords) fixed. */
export function zoomAt(v: Viewport, anchor: Point, factor: number): Viewport {
  const scale = clampScale(v.scale * factor);
  const world = screenToWorld(v, anchor);
  return { scale, x: anchor.x - world.x * scale, y: anchor.y - world.y * scale };
}

export function panBy(v: Viewport, dx: number, dy: number): Viewport {
  return { ...v, x: v.x + dx, y: v.y + dy };
}

/** World-space rectangle currently visible in a screen of size width x height, plus `margin` screen px. */
export function visibleWorldRect(v: Viewport, width: number, height: number, margin = 0): Rect {
  const tl = screenToWorld(v, { x: -margin, y: -margin });
  const br = screenToWorld(v, { x: width + margin, y: height + margin });
  return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

/** Normalise a rectangle drawn from any corner (negative width/height). */
export function normalizeRect(r: Rect): Rect {
  return {
    x: r.width < 0 ? r.x + r.width : r.x,
    y: r.height < 0 ? r.y + r.height : r.y,
    width: Math.abs(r.width),
    height: Math.abs(r.height),
  };
}

/** Wheel delta -> zoom factor. Smooth for trackpads (small deltas), bounded for mice. */
export function wheelZoomFactor(deltaY: number): number {
  const clamped = Math.max(-50, Math.min(50, deltaY));
  return Math.exp(-clamped * 0.01);
}

/** Viewport that fits `bounds` into a screen with padding (e.g. "zoom to fit"). */
export function fitRect(bounds: Rect, width: number, height: number, padding = 48): Viewport {
  if (bounds.width <= 0 || bounds.height <= 0) return { ...IDENTITY, x: width / 2, y: height / 2 };
  const scale = clampScale(
    Math.min((width - padding * 2) / bounds.width, (height - padding * 2) / bounds.height),
  );
  return {
    scale,
    x: (width - bounds.width * scale) / 2 - bounds.x * scale,
    y: (height - bounds.height * scale) / 2 - bounds.y * scale,
  };
}
