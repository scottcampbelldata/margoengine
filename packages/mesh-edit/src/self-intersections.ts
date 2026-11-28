// Which triangles of a mesh meet anywhere but in the corner or edge they share, decided exactly on the stored numbers:
// each side test runs in float64 with a bound on its error and falls back to BigInt when the bound cannot decide
// (J. R. Shewchuk, "Adaptive precision floating-point arithmetic and fast robust geometric predicates", Discrete and
// Computational Geometry 18, 1997, https://doi.org/10.1007/PL00009321). Candidate pairs come from a sweep along one
// axis. Two triangles with no shared corner meet exactly when an edge of one meets the other (Guigue and Devillers,
// "Fast and robust triangle-triangle overlap test using orientation predicates", Journal of Graphics Tools 8, 2003,
// https://doi.org/10.1080/10867651.2003.10487580).

import { indexOfLeast } from './least.js';

/** A bound on a float 3 by 3 orientation's error as a share of its permanent: over 8 steps of float64. */
const FILTER = 2e-15;

const buffer = new DataView(new ArrayBuffer(8));

/** `x` as m times 2^e with an integer m. */
function parts(x: number): { m: bigint; e: number } {
  buffer.setFloat64(0, x);
  const bits = buffer.getBigUint64(0),
    biased = Number((bits >> 52n) & 2047n),
    fraction = bits & ((1n << 52n) - 1n),
    m = biased ? fraction | (1n << 52n) : fraction;
  return { m: bits >> 63n ? -m : m, e: (biased || 1) - 1075 };
}

/**
 * The pairs of `triangles` (corner indices into `vertices`) that meet outside their shared corners, as index pairs with
 * the first index lower. `active`, when given, limits the pairs to those with a triangle it marks.
 */
export function crossingTriangles(
  vertices: readonly (readonly number[])[],
  triangles: readonly (readonly number[])[],
  active?: (triangle: number) => boolean,
  tick: () => void = () => {},
): [number, number][] {
  const exact: (bigint[] | undefined)[] = [];
  let least: number | undefined;
  /** Point `v` as integers in one power-of-two scale. */
  const integers = (v: number): bigint[] => {
    let point = exact[v];
    if (!point) {
      if (least === undefined) {
        least = 0;
        for (const p of vertices) for (const x of p) if (x) least = Math.min(least, parts(x).e);
      }
      const scale = least;
      exact[v] = point = vertices[v].map((x) => {
        const { m, e } = parts(x);
        return m ? m << BigInt(e - scale) : 0n;
      });
    }
    return point;
  };
  /** Which side of the plane through a, b, c the point d is on: 1, -1 or exactly 0. */
  const side = (a: number, b: number, c: number, d: number): number => {
    const A = vertices[a],
      B = vertices[b],
      C = vertices[c],
      D = vertices[d],
      ux = B[0] - A[0],
      uy = B[1] - A[1],
      uz = B[2] - A[2],
      vx = C[0] - A[0],
      vy = C[1] - A[1],
      vz = C[2] - A[2],
      wx = D[0] - A[0],
      wy = D[1] - A[1],
      wz = D[2] - A[2],
      p = vy * wz,
      q = vz * wy,
      r = vz * wx,
      s = vx * wz,
      t = vx * wy,
      u = vy * wx,
      value = ux * (p - q) + uy * (r - s) + uz * (t - u),
      bound =
        FILTER *
        (Math.abs(ux) * (Math.abs(p) + Math.abs(q)) +
          Math.abs(uy) * (Math.abs(r) + Math.abs(s)) +
          Math.abs(uz) * (Math.abs(t) + Math.abs(u)));
    // Four points level on one axis lie in one plane exactly: common on flat sides, where BigInt would decide each.
    if ((!ux && !vx && !wx) || (!uy && !vy && !wy) || (!uz && !vz && !wz)) return 0;
    // Overflow gives NaN or an infinite bound and underflow a value under the smallest bound: BigInt then decides.
    if (bound > 1e-280) {
      if (value > bound) return 1;
      if (value < -bound) return -1;
    }
    const [E, F, G, H] = [integers(a), integers(b), integers(c), integers(d)],
      i = [0, 1, 2].map((k) => F[k] - E[k]),
      j = [0, 1, 2].map((k) => G[k] - E[k]),
      l = [0, 1, 2].map((k) => H[k] - E[k]),
      det =
        i[0] * (j[1] * l[2] - j[2] * l[1]) + i[1] * (j[2] * l[0] - j[0] * l[2]) + i[2] * (j[0] * l[1] - j[1] * l[0]);
    return det > 0n ? 1 : det < 0n ? -1 : 0;
  };
  /** Which way a, b, c turn seen along `axis`: 1, -1 or exactly 0. */
  const turn = (axis: number, a: number, b: number, c: number): number => {
    const x = (axis + 1) % 3,
      y = (axis + 2) % 3,
      A = vertices[a],
      B = vertices[b],
      C = vertices[c],
      p = (B[x] - A[x]) * (C[y] - A[y]),
      q = (B[y] - A[y]) * (C[x] - A[x]),
      bound = FILTER * (Math.abs(p) + Math.abs(q));
    if (bound > 1e-280) {
      if (p - q > bound) return 1;
      if (p - q < -bound) return -1;
    }
    const [E, F, G] = [integers(a), integers(b), integers(c)],
      det = (F[x] - E[x]) * (G[y] - E[y]) - (F[y] - E[y]) * (G[x] - E[x]);
    return det > 0n ? 1 : det < 0n ? -1 : 0;
  };
  /** An axis along which the triangle keeps its area, or -1 for one on a line. */
  const flatAxis = (t: readonly number[]): number => {
    for (let axis = 0; axis < 3; axis++) if (turn(axis, t[0], t[1], t[2])) return axis;
    return -1;
  };
  const within = (axis: number, p: number, t: readonly number[]): boolean => {
    const a = turn(axis, t[0], t[1], p),
      b = turn(axis, t[1], t[2], p),
      c = turn(axis, t[2], t[0], p);
    return !((a > 0 || b > 0 || c > 0) && (a < 0 || b < 0 || c < 0));
  };
  /** Whether segments pq and rs, in one plane seen along `axis`, meet. */
  const segments = (axis: number, p: number, q: number, r: number, s: number): boolean => {
    const a = turn(axis, p, q, r),
      b = turn(axis, p, q, s),
      c = turn(axis, r, s, p),
      d = turn(axis, r, s, q);
    if (a || b) return a * b <= 0 && c * d <= 0;
    // All four on one line: their spans must meet on both axes of the view.
    return [(axis + 1) % 3, (axis + 2) % 3].every(
      (k) =>
        Math.max(vertices[p][k], vertices[q][k]) >= Math.min(vertices[r][k], vertices[s][k]) &&
        Math.max(vertices[r][k], vertices[s][k]) >= Math.min(vertices[p][k], vertices[q][k]),
    );
  };
  /** Whether segment pq meets triangle t, edges and corners included. */
  const pierces = (p: number, q: number, t: readonly number[]): boolean => {
    const a = side(t[0], t[1], t[2], p),
      b = side(t[0], t[1], t[2], q);
    if (a * b > 0) return false;
    if (!a && !b) {
      const axis = flatAxis(t);
      if (axis < 0) return false;
      return (
        within(axis, p, t) ||
        within(axis, q, t) ||
        segments(axis, p, q, t[0], t[1]) ||
        segments(axis, p, q, t[1], t[2]) ||
        segments(axis, p, q, t[2], t[0])
      );
    }
    const x = side(p, q, t[0], t[1]),
      y = side(p, q, t[1], t[2]),
      z = side(p, q, t[2], t[0]);
    return !((x > 0 || y > 0 || z > 0) && (x < 0 || y < 0 || z < 0));
  };
  const meet = (s: readonly number[], t: readonly number[]): boolean => {
    const shared = s.filter((v) => t.includes(v));
    if (shared.length === 3) return true;
    if (shared.length === 2) {
      // Only a fold onto itself overlaps: both third corners in one plane, on the same side of the shared edge.
      const [a, b] = shared,
        c = s.find((v) => !shared.includes(v))!,
        d = t.find((v) => !shared.includes(v))!;
      if (side(a, b, c, d)) return false;
      const axis = flatAxis(s);
      return axis >= 0 && turn(axis, a, b, c) * turn(axis, a, b, d) > 0;
    }
    if (shared.length === 1) {
      const far = (triangle: readonly number[]): [number, number] => {
        const at = triangle.indexOf(shared[0]);
        return [triangle[(at + 1) % 3], triangle[(at + 2) % 3]];
      };
      return pierces(...far(s), t) || pierces(...far(t), s);
    }
    for (let i = 0; i < 3; i++) if (pierces(s[i], s[(i + 1) % 3], t) || pierces(t[i], t[(i + 1) % 3], s)) return true;
    return false;
  };

  const count = triangles.length,
    low = new Float64Array(count * 3),
    high = new Float64Array(count * 3),
    spread = [0, 0, 0];
  triangles.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const a = vertices[t[0]][k],
        b = vertices[t[1]][k],
        c = vertices[t[2]][k];
      low[i * 3 + k] = Math.min(a, b, c);
      high[i * 3 + k] = Math.max(a, b, c);
    }
  });
  // Sweep along the axis on which the boxes overlap least: the one whose widths add to the smallest share of its range.
  for (let k = 0; k < 3; k++) {
    let from = Infinity,
      to = -Infinity,
      widths = 0;
    for (let i = 0; i < count; i++) {
      from = Math.min(from, low[i * 3 + k]);
      to = Math.max(to, high[i * 3 + k]);
      widths += high[i * 3 + k] - low[i * 3 + k];
    }
    spread[k] = to > from ? widths / (to - from) : Infinity;
  }
  const axis = indexOfLeast(spread),
    u = (axis + 1) % 3,
    v = (axis + 2) % 3,
    order = Array.from({ length: count }, (_, i) => i).sort((a, b) => low[a * 3 + axis] - low[b * 3 + axis] || a - b),
    out: [number, number][] = [];
  for (let at = 0; at < count; at++) {
    tick();
    const i = order[at],
      mine = !active || active(i);
    for (let next = at + 1; next < count && low[order[next] * 3 + axis] <= high[i * 3 + axis]; next++) {
      const j = order[next];
      if (
        low[j * 3 + u] > high[i * 3 + u] ||
        high[j * 3 + u] < low[i * 3 + u] ||
        low[j * 3 + v] > high[i * 3 + v] ||
        high[j * 3 + v] < low[i * 3 + v] ||
        (!mine && !active!(j))
      )
        continue;
      if (meet(triangles[i], triangles[j])) out.push(i < j ? [i, j] : [j, i]);
    }
  }
  return out;
}
