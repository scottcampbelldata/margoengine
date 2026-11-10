import type { ModelBox } from './model-data.js';

/** Internal exact rectangle subtraction for the boundary of a union of boxes. */
export function faceRectangles(
  box: ModelBox,
  direction: number,
  blockers: readonly ModelBox[],
  ownIndex = -1,
): number[][] {
  const a = direction >> 1,
    u = (a + 1) % 3,
    v = (a + 2) % 3,
    positive = !(direction & 1),
    plane = positive ? box.max[a] : box.min[a];
  let rectangles = [[box.min[u], box.min[v], box.max[u], box.max[v]]];
  for (let k = 0; k < blockers.length; k++) {
    if (k === ownIndex) continue;
    const other = blockers[k];
    const crosses = positive
      ? other.min[a] <= plane && other.max[a] > plane
      : other.min[a] < plane && other.max[a] >= plane;
    const duplicate = k < ownIndex && (positive ? other.max[a] : other.min[a]) === plane;
    if (!crosses && !duplicate) continue;
    rectangles = rectangles.flatMap(([x0, y0, x1, y1]) => {
      const l = Math.max(x0, other.min[u]),
        b = Math.max(y0, other.min[v]),
        r = Math.min(x1, other.max[u]),
        t = Math.min(y1, other.max[v]);
      if (l >= r || b >= t) return [[x0, y0, x1, y1]];
      return [
        [x0, y0, l, y1],
        [r, y0, x1, y1],
        [l, y0, r, b],
        [l, t, r, y1],
      ].filter(([x, y, z, w]) => x < z && y < w);
    });
  }
  return rectangles;
}

/** Internal canonical face corner, counter-clockwise from outside. */
export function faceCorner(box: ModelBox, direction: number, corner: number): number[] {
  const a = direction >> 1,
    u = (a + 1) % 3,
    v = (a + 2) % 3,
    p = !(direction & 1),
    far = corner === 1 || corner === 2,
    side = corner >= 2,
    out = [0, 0, 0];
  out[a] = p ? box.max[a] : box.min[a];
  out[u] = (p ? far : side) ? box.max[u] : box.min[u];
  out[v] = (p ? side : far) ? box.max[v] : box.min[v];
  return out;
}
