// Convex polygons on the ground plane `[x, z]` for the city generator: half-plane clipping that keeps a label per edge,
// inset and outset by a distance per edge, splitting by a line, the smallest oriented box and the largest rectangle
// along one edge. Every polygon here has positive shoelace area in (x, z), so the inside is on the left of each edge.
// Internal to @margoengine/procedural; our own code.

export type V2 = readonly [number, number];
/** A convex polygon; `e[i]` labels the edge from `p[i]` to the next corner. */
export interface Poly {
  p: V2[];
  e: number[];
}
export const add2 = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
export const sub2 = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
export const mul2 = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];
export const dot2 = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
export const length2 = (a: V2) => Math.hypot(a[0], a[1]);
export const unit2 = (a: V2): V2 => {
  const l = length2(a);
  return l > 0 ? [a[0] / l, a[1] / l] : [1, 0];
};
/** The left normal of a direction: toward the inside for an edge of a polygon here. */
export const left = (d: V2): V2 => [-d[1], d[0]];

export function area(p: readonly V2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
export function centroid(p: readonly V2[]): V2 {
  let x = 0,
    z = 0,
    s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length],
      c = a[0] * b[1] - b[0] * a[1];
    s += c;
    x += (a[0] + b[0]) * c;
    z += (a[1] + b[1]) * c;
  }
  if (Math.abs(s) < 1e-12) return p[0] ?? [0, 0];
  return [x / (3 * s), z / (3 * s)];
}
const EPS = 1e-7;
/** The part of a polygon with `dot(n, q) >= c` (n a unit vector); the new edge along the line takes `label`. */
export function clipHalf(poly: Poly, n: V2, c: number, label: number): Poly {
  const p: V2[] = [],
    e: number[] = [],
    count = poly.p.length;
  for (let i = 0; i < count; i++) {
    const a = poly.p[i],
      b = poly.p[(i + 1) % count],
      fa = dot2(n, a) - c,
      fb = dot2(n, b) - c,
      ina = fa >= -EPS,
      inb = fb >= -EPS;
    if (ina) {
      p.push(a);
      e.push(poly.e[i]);
    }
    if (ina !== inb) {
      const t = Math.min(1, Math.max(0, fa / (fa - fb)));
      p.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      e.push(ina ? label : poly.e[i]);
    }
  }
  // A corner on the line comes out twice; the edge between the two has no length, so the first goes.
  for (let i = p.length - 1; i >= 0 && p.length > 1; i--) {
    const b = p[(i + 1) % p.length];
    if (Math.hypot(p[i][0] - b[0], p[i][1] - b[1]) < 1e-6) {
      p.splice(i, 1);
      e.splice(i, 1);
    }
  }
  if (p.length < 3 || area(p) < 1e-6) return { p: [], e: [] };
  return { p, e };
}
/** Both sides of the line through `at` along the unit direction `dir`: the left side first. */
export function split(poly: Poly, at: V2, dir: V2, label: number): [Poly, Poly] {
  const n = left(dir),
    c = dot2(n, at);
  return [clipHalf(poly, n, c, label), clipHalf(poly, [-n[0], -n[1]], -c, label)];
}
/** Every edge moved inward by its own distance (0 keeps it); empty when nothing is left. */
export function inset(poly: Poly, distance: (label: number, edge: number) => number): Poly {
  let out = poly;
  for (let i = 0; i < poly.p.length && out.p.length; i++) {
    const d = distance(poly.e[i], i);
    if (!(d > 0)) continue;
    const a = poly.p[i],
      n = left(unit2(sub2(poly.p[(i + 1) % poly.p.length], a)));
    out = clipHalf(out, n, dot2(n, a) + d, poly.e[i]);
  }
  return out;
}
/** Every edge moved outward by `d`, with mitred corners. */
export function outset(poly: Poly, d: number): Poly {
  const count = poly.p.length,
    lines = poly.p.map((a, i) => {
      const u = unit2(sub2(poly.p[(i + 1) % count], a)),
        n = left(u);
      return { at: [a[0] - n[0] * d, a[1] - n[1] * d] as V2, u };
    });
  return {
    p: lines.map((line, i) => {
      const before = lines[(i + count - 1) % count],
        den = before.u[0] * line.u[1] - before.u[1] * line.u[0];
      if (Math.abs(den) < 1e-9) return line.at;
      const w = sub2(line.at, before.at),
        t = (w[0] * line.u[1] - w[1] * line.u[0]) / den;
      return add2(before.at, mul2(before.u, t));
    }),
    e: [...poly.e],
  };
}
/** The ranges of a polygon along the unit axis `u` and its left normal. */
export function extent(p: readonly V2[], u: V2): [number, number, number, number] {
  const v = left(u);
  let a = Infinity,
    b = -Infinity,
    c = Infinity,
    d = -Infinity;
  for (const q of p) {
    const s = dot2(q, u),
      t = dot2(q, v);
    a = Math.min(a, s);
    b = Math.max(b, s);
    c = Math.min(c, t);
    d = Math.max(d, t);
  }
  return [a, b, c, d];
}
/** The oriented box of least area (one side lies on an edge): its long axis, its two sizes and its middle. */
export function orientedBox(p: readonly V2[]): { u: V2; long: number; short: number; middle: V2 } {
  let best = { u: [1, 0] as V2, long: Infinity, short: Infinity, middle: [0, 0] as V2 },
    least = Infinity;
  for (let i = 0; i < p.length; i++) {
    const u = unit2(sub2(p[(i + 1) % p.length], p[i])),
      [a, b, c, d] = extent(p, u),
      size = (b - a) * (d - c);
    if (size >= least - 1e-9) continue;
    least = size;
    const v = left(u),
      middle = add2(mul2(u, (a + b) / 2), mul2(v, (c + d) / 2));
    best = b - a >= d - c ? { u, long: b - a, short: d - c, middle } : { u: v, long: d - c, short: b - a, middle };
  }
  return best;
}
/** The smallest width of a convex polygon over all directions. */
export function minWidth(p: readonly V2[]): number {
  let best = Infinity;
  for (let i = 0; i < p.length; i++) {
    const [, , c, d] = extent(p, unit2(sub2(p[(i + 1) % p.length], p[i])));
    best = Math.min(best, d - c);
  }
  return p.length ? best : 0;
}
/** Where the line at height `t` along the left normal of `u` crosses a convex polygon: `[low, high]` along `u`. */
function section(p: readonly V2[], u: V2, t: number): [number, number] {
  const v = left(u);
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length],
      ta = dot2(a, v) - t,
      tb = dot2(b, v) - t;
    if ((ta > 1e-9 && tb > 1e-9) || (ta < -1e-9 && tb < -1e-9)) continue;
    const ends =
      Math.abs(ta - tb) < 1e-9
        ? [dot2(a, u), dot2(b, u)]
        : [dot2(a, u) + (dot2(b, u) - dot2(a, u)) * Math.min(1, Math.max(0, ta / (ta - tb)))];
    for (const s of ends) {
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
  }
  return [lo, hi];
}
/** A rectangle with one side along `u`: its range along `u` and along the left normal. */
export interface Rect {
  s0: number;
  s1: number;
  t0: number;
  t1: number;
}
/**
 * The largest rectangle with its first side on the lowest line of a convex polygon along `u` (its front), with sides
 * between `least` and `widest`/`deepest`. In a convex polygon the crossing at every height between two heights holds
 * the overlap of their two crossings, so testing both ends is enough. Depths are tried in 24 steps.
 */
export function frontRect(p: readonly V2[], u: V2, least: number, widest: number, deepest: number): Rect | undefined {
  if (p.length < 3) return undefined;
  const [, , t0, top] = extent(p, u),
    reach = Math.min(top - t0, deepest),
    [lo0, hi0] = section(p, u, t0);
  let best: Rect | undefined,
    most = 0;
  for (let k = 1; k <= 24; k++) {
    const t1 = t0 + (reach * k) / 24,
      [lo1, hi1] = section(p, u, t1),
      lo = Math.max(lo0, lo1),
      hi = Math.min(hi0, hi1),
      width = Math.min(widest, hi - lo),
      depth = t1 - t0;
    if (width < least || depth < least || width * depth <= most + 1e-9) continue;
    most = width * depth;
    const middle = (lo + hi) / 2;
    best = { s0: middle - width / 2, s1: middle + width / 2, t0, t1 };
  }
  return best;
}
