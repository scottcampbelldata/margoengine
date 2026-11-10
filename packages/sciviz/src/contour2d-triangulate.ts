import { rangeError } from '../../shared/errors.js';
type Point = { x: number; y: number };
// Exact dyadic signs are used only when the floating filter cannot certify the determinant.
function integers(values: number[]): bigint[] {
  const view = new DataView(new ArrayBuffer(8));
  const parts = values.map((v) => {
    view.setFloat64(0, v);
    const b = view.getBigUint64(0),
      e = Number((b >> 52n) & 2047n),
      m = (b & ((1n << 52n) - 1n)) | (e ? 1n << 52n : 0n);
    return { m: b >> 63n ? -m : m, e: e ? e - 1075 : -1074 };
  });
  const exponent = Math.min(...parts.map((p) => p.e));
  return parts.map((p) => p.m << BigInt(p.e - exponent));
}
function orient(a: Point, b: Point, c: Point): number {
  const l = (b.x - a.x) * (c.y - a.y),
    r = (b.y - a.y) * (c.x - a.x),
    d = l - r;
  if (Math.abs(d) > 1e-14 * (Math.abs(l) + Math.abs(r))) return Math.sign(d);
  const [ax, ay, bx, by, cx, cy] = integers([a.x, a.y, b.x, b.y, c.x, c.y]);
  const exact = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return exact > 0n ? 1 : exact < 0n ? -1 : 0;
}
function inside(a: Point, b: Point, c: Point, p: Point, ties = true): boolean {
  const x = a.x - p.x,
    y = a.y - p.y,
    u = b.x - p.x,
    v = b.y - p.y,
    s = c.x - p.x,
    t = c.y - p.y;
  const l = (x * x + y * y) * (u * t - v * s),
    m = (u * u + v * v) * (x * t - y * s),
    r = (s * s + t * t) * (x * v - y * u),
    d = l - m + r;
  const bound =
    1e-13 *
    ((x * x + y * y) * (Math.abs(u * t) + Math.abs(v * s)) +
      (u * u + v * v) * (Math.abs(x * t) + Math.abs(y * s)) +
      (s * s + t * t) * (Math.abs(x * v) + Math.abs(y * u)));
  if (Number.isFinite(d) && Math.abs(d) > bound) return d > 0;
  const [ax, ay, bx, by, cx, cy, px, py] = integers([a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y]);
  const X = ax - px,
    Y = ay - py,
    U = bx - px,
    V = by - py,
    S = cx - px,
    T = cy - py;
  const exact =
    (X * X + Y * Y) * (U * T - V * S) - (U * U + V * V) * (X * T - Y * S) + (S * S + T * T) * (X * V - Y * U);
  return ties ? exact >= 0n : exact > 0n;
}
/** Internal incremental Delaunay; exact cocircular ties use insertion order. */
export async function delaunay2D(input: readonly Point[], signal?: AbortSignal): Promise<number[][]> {
  signal?.throwIfAborted();
  const seen = new Set<string>(),
    points = input,
    n = points.length;
  for (const p of input) {
    const key = `${p.x},${p.y}`;
    if (seen.has(key)) throw rangeError('Delaunay sites must have distinct coordinates', 'sciviz');
    seen.add(key);
  }
  // Start from the actual convex hull, avoiding a finite supertriangle's failure on thin domains.
  const sorted = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => points[a].x - points[b].x || points[a].y - points[b].y,
  );
  const half = (ids: number[]) => {
    const out: number[] = [];
    for (const i of ids) {
      while (out.length > 1 && orient(points[out[out.length - 2]], points[out[out.length - 1]], points[i]) <= 0)
        out.pop();
      out.push(i);
    }
    return out.slice(0, -1);
  };
  const hull = [...half(sorted), ...half([...sorted].reverse())];
  if (hull.length < 3) throw rangeError('Delaunay sites must not all be collinear', 'sciviz');
  let triangles = hull.slice(1, -1).map((v, i) => [hull[0], v, hull[i + 2]]);
  // Lawson legalization gives an initial Delaunay hull triangulation before Bowyer-Watson cavities.
  let changed = true,
    rounds = 0;
  while (changed) {
    changed = false;
    const edges = new Map<string, { t: number; a: number; b: number; c: number }>();
    outer: for (let j = 0; j < triangles.length; j++)
      for (let k = 0; k < 3; k++) {
        const [a, b, c] = [triangles[j][k], triangles[j][(k + 1) % 3], triangles[j][(k + 2) % 3]],
          key = a < b ? `${a},${b}` : `${b},${a}`,
          old = edges.get(key);
        if (!old) {
          edges.set(key, { t: j, a, b, c });
          continue;
        }
        const d = old.c;
        if (inside(points[a], points[b], points[c], points[d], false)) {
          triangles[j] = [c, d, b];
          triangles[old.t] = [d, c, a];
          changed = true;
          break outer;
        }
      }
    if (++rounds % 64 === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
      signal?.throwIfAborted();
    }
  }
  const initial = new Set(hull);
  for (let i = 0; i < n; i++) {
    if (initial.has(i)) continue;
    if (i % 64 === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
      signal?.throwIfAborted();
    }
    const boundary = new Map<string, number[]>(),
      keep: number[][] = [];
    for (const ids of triangles) {
      if (!inside(points[ids[0]], points[ids[1]], points[ids[2]], points[i])) {
        keep.push(ids);
        continue;
      }
      for (let k = 0; k < 3; k++) {
        const a = ids[k],
          b = ids[(k + 1) % 3],
          key = a < b ? `${a},${b}` : `${b},${a}`;
        if (boundary.has(key)) boundary.delete(key);
        else boundary.set(key, [a, b]);
      }
    }
    for (const [a, b] of boundary.values()) {
      const sign = orient(points[a], points[b], points[i]);
      if (sign) keep.push(sign > 0 ? [a, b, i] : [b, a, i]);
    }
    triangles = keep;
  }
  signal?.throwIfAborted();
  return triangles;
}
