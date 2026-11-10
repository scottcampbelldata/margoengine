import type { Spline } from './index.js';
import { checkVector, controls, cross, evaluate, segmentCount } from './polynomial.js';

/** Axis-aligned bounds of the complete curve, including its analytic extrema. */
export interface SplineBounds {
  min: Float64Array;
  max: Float64Array;
}
/** Parameters of stationary coordinates, excluding constant coordinates and endpoints. */
export interface SplineExtrema {
  x: number[];
  y: number[];
  z: number[];
  values: number[];
}
/** Intersection precision and bounded subdivision work. */
export interface SplineQueryOptions {
  /** Spatial acceptance tolerance in world units. Default 1e-7. */
  tolerance?: number;
  /** Parameter deduplication tolerance. Default 1e-7. */
  parameterTolerance?: number;
  /** Maximum curve-pair subdivision nodes. Default 200000. */
  maxWork?: number;
}
/** An isolated curve hit; otherT is the second curve parameter or the ray parameter. */
export interface SplineIntersection {
  t: number;
  otherT?: number;
  point: Float64Array;
}
/** A continuous intersection, represented explicitly rather than as infinitely many point hits. */
export interface SplineOverlap {
  t0: number;
  t1: number;
  otherT0?: number;
  otherT1?: number;
}
/** Ordered isolated points and continuous overlap spans. */
export interface SplineIntersections {
  points: SplineIntersection[];
  overlaps: SplineOverlap[];
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Float64Array =>
  new Float64Array([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
const clamp = (t: number): number => Math.max(0, Math.min(1, t));
const unique = (values: number[], eps = 1e-12): number[] =>
  values.sort((a, b) => a - b).filter((v, i, a) => !i || v - a[i - 1] > eps);
const coefficients = (p: ArrayLike<number>): number[] => [
  p[0],
  3 * (p[1] - p[0]),
  3 * (p[2] - 2 * p[1] + p[0]),
  p[3] - 3 * p[2] + 3 * p[1] - p[0],
];
const scalarAt = (c: number[], t: number): number => ((c[3] * t + c[2]) * t + c[1]) * t + c[0];
function quadratic(a: number, b: number, c: number): number[] {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (!scale) return [];
  a /= scale;
  b /= scale;
  c /= scale;
  if (Math.abs(a) <= Number.EPSILON * 8) return b ? [-c / b] : [];
  const d = b * b - 4 * a * c;
  if (d < 0) return [];
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(d));
  return q ? unique([q / a, c / q]) : [-b / (2 * a)];
}
// Critical-point isolation catches even-multiplicity contacts as well as sign changes.
function roots(p: ArrayLike<number>): { roots: number[]; constant: boolean } {
  const c = coefficients(p),
    scale = Math.max(...c.map(Math.abs));
  if (!scale) return { roots: [], constant: true };
  const f = c.map((v) => v / scale),
    cuts = unique([0, ...quadratic(3 * f[3], 2 * f[2], f[1]).filter((t) => t > 0 && t < 1), 1]);
  const found = cuts.filter((t) => Math.abs(scalarAt(f, t)) <= 64 * Number.EPSILON);
  for (let i = 1; i < cuts.length; i++) {
    let lo = cuts[i - 1],
      hi = cuts[i],
      flo = scalarAt(f, lo);
    if (flo * scalarAt(f, hi) >= 0) continue;
    for (let k = 0; k < 64; k++) {
      const mid = (lo + hi) / 2,
        fm = scalarAt(f, mid);
      if (fm === 0) {
        lo = hi = mid;
        break;
      }
      if (flo * fm < 0) hi = mid;
      else {
        lo = mid;
        flo = fm;
      }
    }
    found.push((lo + hi) / 2);
  }
  return { roots: unique(found), constant: false };
}
function settings(o: SplineQueryOptions): Required<SplineQueryOptions> {
  const tolerance = o.tolerance ?? 1e-7,
    parameterTolerance = o.parameterTolerance ?? 1e-7,
    maxWork = o.maxWork ?? 200000;
  if (
    !Number.isFinite(tolerance) ||
    tolerance <= 0 ||
    !Number.isFinite(parameterTolerance) ||
    parameterTolerance <= 0 ||
    parameterTolerance >= 1 ||
    !Number.isSafeInteger(maxWork) ||
    maxWork < 1
  )
    throw new RangeError('Invalid curve query options; pass positive tolerances and a positive integer maxWork.');
  return { tolerance, parameterTolerance, maxWork };
}
function finish(result: SplineIntersections, eps: number): SplineIntersections {
  result.points.sort((a, b) => a.t - b.t || (a.otherT ?? 0) - (b.otherT ?? 0));
  result.points = result.points.filter(
    (h, i, a) =>
      !a.slice(0, i).some((p) => Math.abs(p.t - h.t) <= eps && Math.abs((p.otherT ?? 0) - (h.otherT ?? 0)) <= eps),
  );
  result.overlaps.sort((a, b) => a.t0 - b.t0);
  result.points = result.points.filter(
    (h) =>
      !result.overlaps.some(
        (s) =>
          h.t >= s.t0 - eps &&
          h.t <= s.t1 + eps &&
          (h.otherT === undefined ||
            s.otherT0 === undefined ||
            (h.otherT >= Math.min(s.otherT0, s.otherT1!) - eps && h.otherT <= Math.max(s.otherT0, s.otherT1!) + eps)),
      ),
  );
  return result;
}

/** Solve derivative quadratics per piece; includes joins as candidates for extrema of a piecewise curve. */
export function splineExtrema(spline: Spline): SplineExtrema {
  const axes: number[][] = [[], [], []],
    n = segmentCount(spline);
  for (let i = 0; i < n; i++) {
    const p = controls(spline, i);
    for (let a = 0; a < 3; a++) {
      const c = coefficients([p[a], p[a + 3], p[a + 6], p[a + 9]]);
      axes[a].push(
        ...quadratic(3 * c[3], 2 * c[2], c[1])
          .filter((t) => t > 0 && t < 1)
          .map((t) => (i + t) / n),
      );
      if (i) axes[a].push(i / n);
    }
  }
  const [x, y, z] = axes.map((a) => unique(a));
  return { x, y, z, values: unique([...x, ...y, ...z]) };
}

/** Tight analytic bounds; unaffected by the spline's arc-length sampling resolution. */
export function splineBounds(spline: Spline): SplineBounds {
  const min = new Float64Array([Infinity, Infinity, Infinity]),
    max = new Float64Array([-Infinity, -Infinity, -Infinity]);
  for (const t of [0, 1, ...splineExtrema(spline).values]) {
    const p = spline.at(t);
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p[a]);
      max[a] = Math.max(max[a], p[a]);
    }
  }
  return { min, max };
}

/** Intersect normal dot point + constant = 0; coplanar pieces become overlaps. Normal need not be unit length. */
export function intersectSplinePlane(
  spline: Spline,
  normal: ArrayLike<number>,
  constant = 0,
  options: SplineQueryOptions = {},
): SplineIntersections {
  checkVector(normal);
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (!length || !Number.isFinite(constant))
    throw new RangeError('Invalid plane; pass a nonzero normal and finite constant.');
  const { parameterTolerance } = settings(options),
    n = segmentCount(spline),
    result: SplineIntersections = { points: [], overlaps: [] };
  for (let i = 0; i < n; i++) {
    const p = controls(spline, i),
      distances = [0, 1, 2, 3].map((j) => (dot(p.subarray(j * 3, j * 3 + 3), normal) + constant) / length);
    const hit = roots(distances);
    if (hit.constant) result.overlaps.push({ t0: i / n, t1: (i + 1) / n });
    else for (const u of hit.roots) result.points.push({ t: (i + u) / n, point: evaluate(p, u, 0) });
  }
  return finish(result, parameterTolerance);
}

/** Intersect a forward ray origin + direction * otherT, including collinear spans and 3D separation checks. */
export function intersectSplineRay(
  spline: Spline,
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
  options: SplineQueryOptions = {},
): SplineIntersections {
  checkVector(origin);
  checkVector(direction);
  const norm = Math.hypot(direction[0], direction[1], direction[2]);
  if (!norm) throw new RangeError('Invalid ray; pass a nonzero direction.');
  const { tolerance, parameterTolerance } = settings(options),
    d = Float64Array.from(direction, (v) => v / norm);
  let axis = 0;
  for (let a = 1; a < 3; a++) if (Math.abs(d[a]) < Math.abs(d[axis])) axis = a;
  const basis = new Float64Array(3);
  basis[axis] = 1;
  const u = cross(d, basis),
    v = cross(d, u),
    n = segmentCount(spline),
    result: SplineIntersections = { points: [], overlaps: [] };
  for (let i = 0; i < n; i++) {
    const p = controls(spline, i),
      relative = [0, 1, 2, 3].map((j) => sub(p.subarray(j * 3, j * 3 + 3), origin));
    const pu = relative.map((p) => dot(p, u)),
      pv = relative.map((p) => dot(p, v)),
      along = relative.map((p) => dot(p, d));
    const primary = Math.max(...pu.map(Math.abs)) >= Math.max(...pv.map(Math.abs)) ? pu : pv;
    const solution = roots(primary);
    if (solution.constant) {
      const c = coefficients(along),
        cuts = unique([
          0,
          ...roots(along).roots,
          ...quadratic(3 * c[3], 2 * c[2], c[1]).filter((t) => t > 0 && t < 1),
          1,
        ]);
      for (let j = 1; j < cuts.length; j++)
        if (scalarAt(c, (cuts[j - 1] + cuts[j]) / 2) >= 0)
          result.overlaps.push({
            t0: (i + cuts[j - 1]) / n,
            t1: (i + cuts[j]) / n,
            otherT0: scalarAt(c, cuts[j - 1]) / norm,
            otherT1: scalarAt(c, cuts[j]) / norm,
          });
    } else
      for (const t of solution.roots) {
        const point = evaluate(p, t, 0),
          q = sub(point, origin),
          distance = dot(q, d);
        if (distance >= -tolerance && Math.hypot(...cross(q, d)) <= tolerance)
          result.points.push({ t: (i + t) / n, otherT: Math.max(0, distance / norm), point });
      }
  }
  return finish(result, parameterTolerance);
}

type Piece = { p: Float64Array; t0: number; t1: number };
function split(piece: Piece): [Piece, Piece] {
  const p = piece.p,
    left = new Float64Array(12),
    right = new Float64Array(12),
    q = p.slice();
  for (let level = 0; level < 4; level++) {
    left.set(q.subarray(0, 3), level * 3);
    right.set(q.subarray((3 - level) * 3, (4 - level) * 3), (3 - level) * 3);
    for (let j = 0; j < 3 - level; j++)
      for (let a = 0; a < 3; a++) q[j * 3 + a] = (q[j * 3 + a] + q[(j + 1) * 3 + a]) / 2;
  }
  const mid = (piece.t0 + piece.t1) / 2;
  return [
    { p: left, t0: piece.t0, t1: mid },
    { p: right, t0: mid, t1: piece.t1 },
  ];
}
function box(p: Float64Array): SplineBounds {
  return {
    min: new Float64Array([0, 1, 2].map((a) => Math.min(p[a], p[a + 3], p[a + 6], p[a + 9]))),
    max: new Float64Array([0, 1, 2].map((a) => Math.max(p[a], p[a + 3], p[a + 6], p[a + 9]))),
  };
}
const extent = (b: SplineBounds): number => Math.hypot(...sub(b.max, b.min));
function trim(p: Float64Array, lo: number, hi: number): Float64Array {
  const start = evaluate(p, lo, 0),
    end = evaluate(p, hi, 0),
    d0 = evaluate(p, lo, 1),
    d1 = evaluate(p, hi, 1),
    q = new Float64Array(12);
  q.set(start);
  q.set(end, 9);
  for (let a = 0; a < 3; a++) {
    q[a + 3] = start[a] + (d0[a] * (hi - lo)) / 3;
    q[a + 6] = end[a] - (d1[a] * (hi - lo)) / 3;
  }
  return q;
}
function partialOverlap(a: Float64Array, b: Float64Array, eps: number): SplineOverlap | undefined {
  const parameters = (p: Float64Array, point: Float64Array): number[] => {
    const bounds = box(p);
    let axis = 0;
    for (let k = 1; k < 3; k++) if (bounds.max[k] - bounds.min[k] > bounds.max[axis] - bounds.min[axis]) axis = k;
    return roots([0, 1, 2, 3].map((i) => p[i * 3 + axis] - point[axis])).roots.filter(
      (t) => Math.hypot(...sub(evaluate(p, t, 0), point)) <= eps,
    );
  };
  const ends: [number, number][] = [];
  for (const u of [0, 1]) for (const v of parameters(b, evaluate(a, u, 0))) ends.push([u, v]);
  for (const v of [0, 1]) for (const u of parameters(a, evaluate(b, v, 0))) ends.push([u, v]);
  for (const [u0, v0] of ends)
    for (const [u1, v1] of ends)
      if (u1 > u0 + 1e-12 && Math.abs(v1 - v0) > 1e-12) {
        const aa = trim(a, u0, u1),
          bb = trim(b, v0, v1);
        if (aa.every((v, k) => Math.abs(v - bb[k]) <= eps)) return { t0: u0, t1: u1, otherT0: v0, otherT1: v1 };
      }
  return undefined;
}
function lineOverlap(a: Float64Array, b: Float64Array, eps: number): SplineIntersections | undefined {
  const points = [0, 1, 2, 3].map((i) => a.subarray(i * 3, i * 3 + 3)),
    origin = points[0];
  let direction: Float64Array = new Float64Array(3);
  let size = 0;
  for (const p of [...points, ...[0, 1, 2, 3].map((i) => b.subarray(i * 3, i * 3 + 3))]) {
    const d = sub(p, origin),
      length = Math.hypot(...d);
    if (length > size) {
      direction = d;
      size = length;
    }
  }
  if (!size) return undefined;
  const unit = direction.map((v) => v / size);
  if (
    [...points, ...[0, 1, 2, 3].map((i) => b.subarray(i * 3, i * 3 + 3))].some(
      (p) => Math.hypot(...cross(sub(p, origin), unit)) > eps,
    )
  )
    return undefined;
  const scalar = (p: Float64Array): number[] =>
    [0, 1, 2, 3].map((i) => dot(sub(p.subarray(i * 3, i * 3 + 3), origin), unit));
  const sa = scalar(a),
    sb = scalar(b),
    ca = coefficients(sa),
    cb = coefficients(sb);
  const cuts = (c: number[]): number[] =>
    unique([0, ...quadratic(3 * c[3], 2 * c[2], c[1]).filter((t) => t > 0 && t < 1), 1]);
  const ac = cuts(ca),
    bc = cuts(cb),
    result: SplineIntersections = { points: [], overlaps: [] };
  const param = (p: number[], value: number, lo: number, hi: number): number => {
    const r = roots(p.map((v) => v - value));
    if (r.constant) return lo;
    return (
      r.roots.find((t) => t >= lo - 1e-10 && t <= hi + 1e-10) ??
      (Math.abs(scalarAt(coefficients(p), lo) - value) <= eps ? lo : hi)
    );
  };
  for (let i = 1; i < ac.length; i++)
    for (let j = 1; j < bc.length; j++) {
      const a0 = scalarAt(ca, ac[i - 1]),
        a1 = scalarAt(ca, ac[i]),
        b0 = scalarAt(cb, bc[j - 1]),
        b1 = scalarAt(cb, bc[j]);
      const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1)),
        hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
      if (hi < lo - eps) continue;
      let t0 = param(sa, lo, ac[i - 1], ac[i]),
        t1 = param(sa, hi, ac[i - 1], ac[i]);
      let u0 = param(sb, lo, bc[j - 1], bc[j]),
        u1 = param(sb, hi, bc[j - 1], bc[j]);
      if (t0 > t1) {
        [t0, t1] = [t1, t0];
        [u0, u1] = [u1, u0];
      }
      if (Math.abs(hi - lo) <= eps) result.points.push({ t: t0, otherT: u0, point: evaluate(a, t0, 0) });
      else result.overlaps.push({ t0, t1, otherT0: u0, otherT1: u1 });
    }
  return result;
}
function polish(a: Float64Array, b: Float64Array, u: number, v: number): [number, number, number] {
  for (let i = 0; i < 50; i++) {
    const pa = evaluate(a, u, 0),
      pb = evaluate(b, v, 0),
      r = sub(pa, pb),
      da = evaluate(a, u, 1),
      db = evaluate(b, v, 1);
    const aa = dot(da, da),
      bb = dot(db, db),
      ab = dot(da, db),
      ra = dot(r, da),
      rb = dot(r, db),
      det = aa * bb - ab * ab;
    if (det <= Number.EPSILON * aa * bb) break;
    const nu = clamp(u + (ab * rb - bb * ra) / det),
      nv = clamp(v + (aa * rb - ab * ra) / det);
    if (Math.abs(nu - u) + Math.abs(nv - v) < 1e-14) {
      u = nu;
      v = nv;
      break;
    }
    u = nu;
    v = nv;
  }
  return [u, v, Math.hypot(...sub(evaluate(a, u, 0), evaluate(b, v, 0)))];
}

/** 3D curve intersections by convex-hull subdivision and analytic Newton refinement. Identical/reversed pieces report overlap. */
export function intersectSplines(first: Spline, second: Spline, options: SplineQueryOptions = {}): SplineIntersections {
  const { tolerance, parameterTolerance, maxWork } = settings(options),
    n = segmentCount(first),
    m = segmentCount(second);
  const result: SplineIntersections = { points: [], overlaps: [] };
  let work = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      const a = controls(first, i),
        b = controls(second, j);
      const scale = Math.max(1, ...a.map(Math.abs), ...b.map(Math.abs)),
        roundoff = scale * Number.EPSILON * 16;
      const same = (reverse: boolean): boolean =>
        a.every((v, k) => Math.abs(v - b[reverse ? (3 - Math.floor(k / 3)) * 3 + (k % 3) : k]) <= roundoff);
      if (same(false) || same(true)) {
        const reverse = !same(false);
        result.overlaps.push({
          t0: i / n,
          t1: (i + 1) / n,
          otherT0: (j + (reverse ? 1 : 0)) / m,
          otherT1: (j + (reverse ? 0 : 1)) / m,
        });
        continue;
      }
      const lines = lineOverlap(a, b, roundoff);
      if (lines) {
        result.points.push(
          ...lines.points.map((h) => ({ t: (i + h.t) / n, otherT: (j + h.otherT!) / m, point: h.point })),
        );
        result.overlaps.push(
          ...lines.overlaps.map((h) => ({
            t0: (i + h.t0) / n,
            t1: (i + h.t1) / n,
            otherT0: (j + h.otherT0!) / m,
            otherT1: (j + h.otherT1!) / m,
          })),
        );
        continue;
      }
      const overlap = partialOverlap(a, b, roundoff * 4);
      if (overlap) {
        result.overlaps.push({
          t0: (i + overlap.t0) / n,
          t1: (i + overlap.t1) / n,
          otherT0: (j + overlap.otherT0!) / m,
          otherT1: (j + overlap.otherT1!) / m,
        });
        continue;
      }
      const stack: [Piece, Piece][] = [
        [
          { p: a, t0: 0, t1: 1 },
          { p: b, t0: 0, t1: 1 },
        ],
      ];
      while (stack.length) {
        if (++work > maxWork)
          throw Object.assign(
            new RangeError('Curve intersection work limit reached; raise maxWork or split the input curves.'),
            { code: 'limit' },
          );
        const [pa, pb] = stack.pop()!,
          ba = box(pa.p),
          bb = box(pb.p);
        if ([0, 1, 2].some((k) => ba.max[k] + roundoff < bb.min[k] || bb.max[k] + roundoff < ba.min[k])) continue;
        const ea = extent(ba),
          eb = extent(bb);
        if (Math.max(ea, eb) <= tolerance || Math.max(pa.t1 - pa.t0, pb.t1 - pb.t0) <= 1e-12) {
          const [u, v, distance] = polish(a, b, (pa.t0 + pa.t1) / 2, (pb.t0 + pb.t1) / 2);
          if (distance <= tolerance)
            result.points.push({ t: (i + u) / n, otherT: (j + v) / m, point: evaluate(a, u, 0) });
        } else if (ea >= eb) for (const part of split(pa)) stack.push([part, pb]);
        else for (const part of split(pb)) stack.push([pa, part]);
      }
    }
  return finish(result, parameterTolerance);
}
