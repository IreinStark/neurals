/**
 * Ramer–Douglas–Peucker simplification for flat point arrays [x0, y0, x1, y1, ...].
 * Used to commit freehand strokes to Yjs on pointer-up (plan R2 mitigation, spec D4).
 * Iterative (explicit stack) so long strokes can't overflow the call stack.
 */
export function simplifyFlatPoints(points: readonly number[], epsilon = 1): number[] {
  if (points.length % 2 !== 0) throw new RangeError("points must contain x,y pairs");
  const n = points.length / 2;
  if (n <= 2) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const eps2 = epsilon * epsilon;
  const stack: Array<[number, number]> = [[0, n - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const ax = points[first * 2]!;
    const ay = points[first * 2 + 1]!;
    const bx = points[last * 2]!;
    const by = points[last * 2 + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;

    let maxDist2 = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const px = points[i * 2]!;
      const py = points[i * 2 + 1]!;
      let d2: number;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (d2 > maxDist2) {
        maxDist2 = d2;
        index = i;
      }
    }

    if (index !== -1 && maxDist2 > eps2) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(points[i * 2]!, points[i * 2 + 1]!);
  }
  return out;
}
