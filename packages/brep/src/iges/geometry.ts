// IGES curve and surface geometry in model space, from the entity definitions of IGES 5.3 chapter 4: the shapes the
// converter builds from the parameter data before it writes them as STEP entities, with evaluators in each entity's
// own (IGES) parameterization. Exact where STEP has the shape (lines, conic arcs as rational quadratics, B-splines,
// polynomial splines as Bezier segments); fitted with Hermite cubics where it does not (curves on surfaces, offsets).
import { curveAt, surfaceAt } from '../geometry/nurbs.js';

export type V3 = number[];

/** An affine map x' = R x + t (R row-major), with its uniform scale (cube root of |det R|). */
export interface Xf {
  readonly r: readonly number[];
  readonly t: readonly number[];
}

export const identity: Xf = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
export const scaling = (k: number): Xf => ({ r: [k, 0, 0, 0, k, 0, 0, 0, k], t: [0, 0, 0] });
/** outer after inner: x -> outer(inner(x)). */
export function compose(outer: Xf, inner: Xf): Xf {
  const a = outer.r,
    b = inner.r,
    r: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]);
  return { r, t: apply(outer, inner.t) };
}
export const apply = (m: Xf, p: readonly number[]): V3 => {
  const r = m.r;
  return [
    r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + m.t[0],
    r[3] * p[0] + r[4] * p[1] + r[5] * p[2] + m.t[1],
    r[6] * p[0] + r[7] * p[1] + r[8] * p[2] + m.t[2],
  ];
};
export const rotate = (m: Xf, v: readonly number[]): V3 => {
  const r = m.r;
  return [
    r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
    r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
    r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
  ];
};
const determinant = (m: Xf): number => {
  const r = m.r;
  return r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6]);
};
export const scaleOf = (m: Xf): number => Math.cbrt(Math.abs(determinant(m)));

export const add = (a: readonly number[], b: readonly number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: readonly number[], s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: readonly number[], b: readonly number[]): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const unit = (a: readonly number[]): V3 => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
/** Any unit vector perpendicular to unit vector n. */
export const perpendicular = (n: readonly number[]): V3 =>
  unit(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));

/** A B-spline curve: degree, full knot vector, Cartesian control points, weights when rational, its used range. */
export interface Nurbs {
  readonly p: number;
  readonly U: readonly number[];
  readonly P: readonly V3[];
  readonly W?: readonly number[];
  readonly t0: number;
  readonly t1: number;
}

/**
 * A model-space curve. `conic` is c + cos(t) X + sin(t) Y for t0 <= t <= t1 (circles and ellipses, X and Y not
 * necessarily perpendicular after a transform); `native` on a chain says its parameter is the IGES one throughout.
 */
export type Curve3 =
  | { readonly kind: 'line'; readonly a: V3; readonly b: V3 }
  | { readonly kind: 'conic'; readonly c: V3; readonly X: V3; readonly Y: V3; readonly t0: number; readonly t1: number }
  | { readonly kind: 'nurbs'; readonly n: Nurbs }
  | { readonly kind: 'poly'; readonly pts: readonly V3[] }
  | { readonly kind: 'chain'; readonly parts: readonly Curve3[] };

const homogeneous = (n: Nurbs): Float64Array => {
  const out = new Float64Array(n.P.length * 4);
  n.P.forEach((p, i) => {
    const w = n.W?.[i] ?? 1;
    out.set([p[0] * w, p[1] * w, p[2] * w, w], i * 4);
  });
  return out;
};
const splineCache = new WeakMap<Nurbs, Float64Array>();
const nurbsAt = (n: Nurbs, t: number): V3 => {
  let h = splineCache.get(n);
  if (!h) splineCache.set(n, (h = homogeneous(n)));
  return curveAt({ degree: n.p, points: h, knots: n.U }, t).slice(0, 3);
};

/** The curve's parameter range (a chain's runs its parts' ranges end to end, as IGES 102 does). */
export function domain(c: Curve3): [number, number] {
  switch (c.kind) {
    case 'line':
      return [0, 1];
    case 'conic':
      return [c.t0, c.t1];
    case 'nurbs':
      return [c.n.t0, c.n.t1];
    case 'poly':
      return [0, Math.max(1, c.pts.length - 1)];
    case 'chain': {
      let total = 0;
      for (const p of c.parts) {
        const [a, b] = domain(p);
        total += b - a;
      }
      return [0, total];
    }
  }
}

/** The point at t (in the curve's own parameter). */
export function pointAt(c: Curve3, t: number): V3 {
  switch (c.kind) {
    case 'line':
      return add(c.a, mul(sub(c.b, c.a), t));
    case 'conic':
      return add(c.c, add(mul(c.X, Math.cos(t)), mul(c.Y, Math.sin(t))));
    case 'nurbs':
      return nurbsAt(c.n, Math.min(Math.max(t, c.n.U[c.n.p]), c.n.U[c.n.U.length - 1 - c.n.p]));
    case 'poly': {
      const n = c.pts.length;
      if (n === 1) return [...c.pts[0]];
      const i = Math.min(n - 2, Math.max(0, Math.floor(t)));
      return add(c.pts[i], mul(sub(c.pts[i + 1], c.pts[i]), t - i));
    }
    case 'chain': {
      let rest = t;
      for (const [k, p] of c.parts.entries()) {
        const [a, b] = domain(p);
        if (rest <= b - a || k === c.parts.length - 1) return pointAt(p, a + Math.min(rest, b - a));
        rest -= b - a;
      }
      return [0, 0, 0];
    }
  }
}
export const startOf = (c: Curve3): V3 => pointAt(c, domain(c)[0]);
export const endOf = (c: Curve3): V3 => pointAt(c, domain(c)[1]);

/** The curve under an affine map. */
export function transformCurve(c: Curve3, m: Xf): Curve3 {
  switch (c.kind) {
    case 'line':
      return { kind: 'line', a: apply(m, c.a), b: apply(m, c.b) };
    case 'conic':
      return { kind: 'conic', c: apply(m, c.c), X: rotate(m, c.X), Y: rotate(m, c.Y), t0: c.t0, t1: c.t1 };
    case 'nurbs':
      return { kind: 'nurbs', n: { ...c.n, P: c.n.P.map((p) => apply(m, p)) } };
    case 'poly':
      return { kind: 'poly', pts: c.pts.map((p) => apply(m, p)) };
    case 'chain':
      return { kind: 'chain', parts: c.parts.map((p) => transformCurve(p, m)) };
  }
}

/** A rough length (chords through 33 samples per part). */
export function lengthOf(c: Curve3): number {
  if (c.kind === 'chain') return c.parts.reduce((s, p) => s + lengthOf(p), 0);
  if (c.kind === 'line') return dist(c.a, c.b);
  if (c.kind === 'poly') return c.pts.reduce((s, p, i) => (i ? s + dist(p, c.pts[i - 1]) : 0), 0);
  const [a, b] = domain(c);
  let total = 0,
    last = pointAt(c, a);
  for (let i = 1; i <= 32; i++) {
    const p = pointAt(c, a + ((b - a) * i) / 32);
    total += dist(p, last);
    last = p;
  }
  return total;
}

/** The pieces an edge loop is made of: a chain's parts, a polyline's segments, with pieces shorter than `tol` left out. */
export function pieces(c: Curve3, tol: number): Curve3[] {
  if (c.kind === 'chain') return c.parts.flatMap((p) => pieces(p, tol));
  if (c.kind === 'poly') {
    const out: Curve3[] = [];
    for (let i = 1; i < c.pts.length; i++)
      if (dist(c.pts[i], c.pts[i - 1]) > tol) out.push({ kind: 'line', a: [...c.pts[i - 1]], b: [...c.pts[i]] });
    return out;
  }
  return lengthOf(c) > tol ? [c] : [];
}

// --- B-splines from IGES shapes, Bezier pieces, joining ----------------------------------------------------------

/** Homogeneous Bezier pieces of one degree with their parameter breaks (pieces.length + 1 of them). */
export interface Beziers {
  readonly p: number;
  readonly segs: number[][][];
  readonly breaks: number[];
}

/** Boehm's single knot insertion on homogeneous control points (returns new knots and points). */
function insertKnot(p: number, U: number[], Pw: number[][], u: number): [number[], number[][]] {
  // The last knot at or below u (one with a knot above it): at the end of an unclamped range that is past n.
  let k = U.length - 2;
  while (k > p && U[k] > u) k--;
  let s = 0;
  for (const x of U) if (x === u) s++;
  const Q: number[][] = [];
  for (let i = 0; i <= Pw.length; i++) {
    if (i <= k - p) Q.push(Pw[i]);
    else if (i <= k - s) {
      const a = (u - U[i]) / (U[i + p] - U[i]);
      Q.push(Pw[i].map((v, j) => a * v + (1 - a) * Pw[i - 1][j]));
    } else Q.push(Pw[i - 1]);
  }
  return [[...U.slice(0, k + 1), u, ...U.slice(k + 1)], Q];
}

/** Splits a B-spline over its used range [t0, t1] into Bezier pieces. */
function beziersOf(n: Nurbs): Beziers {
  const p = n.p;
  let U = [...n.U],
    Pw = n.P.map((c, i) => {
      const w = n.W?.[i] ?? 1;
      return [c[0] * w, c[1] * w, c[2] * w, w];
    });
  const lo = Math.max(n.t0, U[p]),
    hi = Math.min(n.t1, U[U.length - 1 - p]);
  const targets = [lo, ...U.filter((u) => u > lo && u < hi), hi].filter((u, i, a) => !i || u !== a[i - 1]);
  for (const u of targets) {
    let m = U.filter((x) => x === u).length;
    while (m < p) {
      [U, Pw] = insertKnot(p, U, Pw, u);
      m++;
    }
  }
  const segs: number[][][] = [],
    breaks = [lo];
  for (let i = p; i < U.length - p - 1; i++) {
    if (!(U[i + 1] > U[i]) || U[i + 1] <= lo || U[i] >= hi) continue;
    segs.push(Pw.slice(i - p, i + 1));
    breaks.push(U[i + 1]);
  }
  return { p, segs, breaks };
}

/** Raises a homogeneous Bezier piece by one degree. */
const elevate = (seg: number[][]): number[][] => {
  const p = seg.length - 1,
    out = [seg[0]];
  for (let i = 1; i <= p; i++) {
    const a = i / (p + 1);
    out.push(seg[i].map((v, j) => a * seg[i - 1][j] + (1 - a) * v));
  }
  out.push(seg[p]);
  return out;
};
/** Splits a homogeneous Bezier piece at local parameter s (de Casteljau). */
export function splitBezier(seg: number[][], s: number): [number[][], number[][]] {
  const left: number[][] = [],
    right: number[][] = [];
  let row = seg;
  while (row.length) {
    left.push(row[0]);
    right.unshift(row[row.length - 1]);
    const next: number[][] = [];
    for (let i = 0; i + 1 < row.length; i++) next.push(row[i].map((v, j) => (1 - s) * v + s * row[i + 1][j]));
    row = next;
  }
  return [left, right];
}
export function raiseTo(b: Beziers, p: number): Beziers {
  return {
    p,
    breaks: b.breaks,
    segs: b.segs.map((s) => {
      let out = s;
      while (out.length - 1 < p) out = elevate(out);
      return out;
    }),
  };
}
/** Joins Bezier pieces into one B-spline (interior knots of multiplicity p). */
export function fromBeziers(b: Beziers): Nurbs {
  const { p, segs, breaks } = b,
    U: number[] = [],
    Pw: number[][] = [];
  for (let k = 0; k <= p; k++) U.push(breaks[0]);
  segs.forEach((s, i) => {
    for (let j = i ? 1 : 0; j <= p; j++) Pw.push(s[j]);
    for (let k = 0; k < (i === segs.length - 1 ? p + 1 : p); k++) U.push(breaks[i + 1]);
  });
  const rational = Pw.some((q) => Math.abs(q[3] - 1) > 1e-14);
  return {
    p,
    U,
    P: Pw.map((q) => [q[0] / q[3], q[1] / q[3], q[2] / q[3]]),
    ...(rational ? { W: Pw.map((q) => q[3]) } : {}),
    t0: breaks[0],
    t1: breaks[breaks.length - 1],
  };
}

/** Bezier pieces of a conic arc: rational quadratics of at most a quarter turn each, with angle breaks. */
function conicBeziers(c: Extract<Curve3, { kind: 'conic' }>): Beziers {
  const k = Math.max(1, Math.ceil((c.t1 - c.t0) / (Math.PI / 2) - 1e-9)),
    step = (c.t1 - c.t0) / k,
    w = Math.cos(step / 2),
    segs: number[][][] = [],
    breaks = [c.t0];
  for (let i = 0; i < k; i++) {
    const a = c.t0 + i * step,
      b = a + step,
      m = (a + b) / 2,
      p0 = pointAt(c, a),
      p2 = pointAt(c, b),
      p1 = add(c.c, mul(add(mul(c.X, Math.cos(m)), mul(c.Y, Math.sin(m))), 1 / w));
    segs.push([
      [...p0, 1],
      [p1[0] * w, p1[1] * w, p1[2] * w, w],
      [...p2, 1],
    ]);
    breaks.push(b);
  }
  return { p: 2, segs, breaks };
}

/** Exact Bezier pieces of any curve (parameters run as the curve's own, a chain's end to end). */
export function beziersOfCurve(c: Curve3): Beziers | undefined {
  switch (c.kind) {
    case 'line':
      return {
        p: 1,
        segs: [
          [
            [...c.a, 1],
            [...c.b, 1],
          ],
        ],
        breaks: [0, 1],
      };
    case 'poly':
      if (c.pts.length < 2) return undefined;
      return {
        p: 1,
        segs: c.pts.slice(1).map((q, i) => [
          [...c.pts[i], 1],
          [...q, 1],
        ]),
        breaks: c.pts.map((_, i) => i),
      };
    case 'conic':
      return conicBeziers(c);
    case 'nurbs':
      return beziersOf(c.n);
    case 'chain': {
      const parts = c.parts.map(beziersOfCurve);
      if (!parts.length || parts.some((b) => !b || !b.segs.length)) return undefined;
      const p = Math.max(...parts.map((b) => b!.p)),
        segs: number[][][] = [],
        breaks = [0];
      let offset = 0;
      for (const b of parts as Beziers[]) {
        const raised = raiseTo(b, p);
        for (let i = 0; i < raised.segs.length; i++) {
          segs.push(raised.segs[i]);
          breaks.push(offset + raised.breaks[i + 1] - raised.breaks[0]);
        }
        offset += raised.breaks[raised.breaks.length - 1] - raised.breaks[0];
      }
      return { p, segs, breaks };
    }
  }
}

/** The curve as one exact B-spline (a chain's pieces raised to one degree), or undefined. */
export function nurbsOf(c: Curve3): Nurbs | undefined {
  if (c.kind === 'nurbs') return c.n;
  const b = beziersOfCurve(c);
  return b && b.segs.length ? fromBeziers(b) : undefined;
}

// --- fitting --------------------------------------------------------------------------------------------------------

/**
 * A cubic B-spline through f over [t0, t1]: Hermite pieces with numerical end tangents, halved until each stays
 * within `tol` of f at its quarter points (at most 10 halvings, 2048 pieces).
 */
export function fit(f: (t: number) => V3, t0: number, t1: number, tol: number, start = 4): Nurbs {
  const span = t1 - t0,
    h = span * 1e-6,
    d = (t: number): V3 => {
      // Second-order differences, one-sided at the ends so f is only evaluated inside [t0, t1].
      if (t - h < t0) return mul(add(add(mul(f(t), -3), mul(f(t + h), 4)), mul(f(t + 2 * h), -1)), 1 / (2 * h));
      if (t + h > t1) return mul(add(add(mul(f(t), 3), mul(f(t - h), -4)), f(t - 2 * h)), 1 / (2 * h));
      return mul(sub(f(t + h), f(t - h)), 1 / (2 * h));
    };
  const segs: number[][][] = [],
    breaks = [t0];
  const piece = (a: number, pa: V3, da: V3, b: number, pb: V3, db: V3, depth: number) => {
    const k = (b - a) / 3,
      ctrl = [pa, add(pa, mul(da, k)), sub(pb, mul(db, k)), pb],
      bez = (s: number) => {
        const r = 1 - s;
        return add(
          add(mul(ctrl[0], r * r * r), mul(ctrl[1], 3 * r * r * s)),
          add(mul(ctrl[2], 3 * r * s * s), mul(ctrl[3], s * s * s)),
        );
      };
    let err = 0;
    for (const s of [0.25, 0.5, 0.75]) err = Math.max(err, dist(bez(s), f(a + (b - a) * s)));
    if (err > tol && depth < 10 && segs.length < 2048) {
      const m = (a + b) / 2,
        pm = f(m),
        dm = d(m);
      piece(a, pa, da, m, pm, dm, depth + 1);
      piece(m, pm, dm, b, pb, db, depth + 1);
      return;
    }
    segs.push(ctrl.map((q) => [...q, 1]));
    breaks.push(b);
  };
  let a = t0,
    pa = f(t0),
    da = d(t0);
  for (let i = 1; i <= start; i++) {
    const b = i === start ? t1 : t0 + (span * i) / start,
      pb = f(b),
      db = d(b);
    piece(a, pa, da, b, pb, db, 0);
    a = b;
    pa = pb;
    da = db;
  }
  return fromBeziers({ p: 3, segs, breaks });
}

// --- surfaces -------------------------------------------------------------------------------------------------------

/** A B-spline surface: degrees, full knot vectors, control net with u varying fastest (index j * nu + i). */
export interface NurbsSurface {
  readonly pu: number;
  readonly pv: number;
  readonly U: readonly number[];
  readonly V: readonly number[];
  readonly nu: number;
  readonly nv: number;
  readonly P: readonly V3[];
  readonly W?: readonly number[];
}

/**
 * A model-space surface in its IGES parameterization. Analytic surfaces (IGES 190 to 198) take u and v in degrees
 * where the specification measures angles; `plane` with no x has no parameterization (IGES 108).
 */
export type Surf =
  | { readonly kind: 'plane'; readonly o: V3; readonly n: V3; readonly x?: V3; readonly y?: V3 }
  | {
      readonly kind: 'cylinder' | 'cone' | 'sphere' | 'torus';
      readonly o: V3;
      readonly x: V3;
      readonly y: V3;
      readonly z: V3;
      /** Radius (major radius for a torus). */
      readonly r: number;
      /** Minor radius of a torus; half angle in radians of a cone. */
      readonly r2: number;
    }
  | { readonly kind: 'nurbs'; readonly s: NurbsSurface; readonly dom: readonly number[] }
  | {
      readonly kind: 'revolution';
      readonly a: V3;
      readonly d: V3;
      readonly curve: Curve3;
      readonly sa: number;
      readonly ta: number;
    }
  | { readonly kind: 'extrusion'; readonly curve: Curve3; readonly v: V3 }
  | { readonly kind: 'offset'; readonly base: Surf; readonly d: number };

const surfaceCache = new WeakMap<NurbsSurface, Float64Array>();
function nurbsSurfaceAt(s: NurbsSurface, u: number, v: number): V3 {
  let h = surfaceCache.get(s);
  if (!h) {
    // nurbs.ts wants u outer: (i * nv + j).
    h = new Float64Array(s.nu * s.nv * 4);
    for (let i = 0; i < s.nu; i++)
      for (let j = 0; j < s.nv; j++) {
        const k = j * s.nu + i,
          w = s.W?.[k] ?? 1,
          c = s.P[k];
        h.set([c[0] * w, c[1] * w, c[2] * w, w], (i * s.nv + j) * 4);
      }
    surfaceCache.set(s, h);
  }
  const cu = Math.min(Math.max(u, s.U[s.pu]), s.U[s.U.length - 1 - s.pu]),
    cv = Math.min(Math.max(v, s.V[s.pv]), s.V[s.V.length - 1 - s.pv]);
  return surfaceAt(
    { uDegree: s.pu, vDegree: s.pv, nu: s.nu, nv: s.nv, points: h, uKnots: s.U, vKnots: s.V },
    cu,
    cv,
  ).slice(0, 3);
}

/** Rotation of p by angle a about the line through o along unit d (right-handed). */
function rotateAbout(p: readonly number[], o: readonly number[], d: readonly number[], a: number): V3 {
  const v = sub(p, o),
    c = Math.cos(a),
    s = Math.sin(a),
    along = dot(d, v);
  return add(o, add(add(mul(v, c), mul(cross(d, v), s)), mul(d, along * (1 - c))));
}

const RAD = Math.PI / 180;

/** The parameter rectangle [u0, u1, v0, v1] (infinite where the surface is unbounded). */
export function surfDomain(s: Surf): number[] {
  switch (s.kind) {
    case 'plane':
      return [-Infinity, Infinity, -Infinity, Infinity];
    case 'cylinder':
    case 'cone':
      return [0, 360, -Infinity, Infinity];
    case 'sphere':
      return [0, 360, -90, 90];
    case 'torus':
      return [0, 360, 0, 360];
    case 'nurbs':
      return [...s.dom];
    case 'revolution':
      return [...domain(s.curve), s.sa, s.ta];
    case 'extrusion':
      return [0, 1, 0, 1];
    case 'offset':
      return surfDomain(s.base);
  }
}

/** S(u, v) in model space; undefined for a plane with no parameterization. */
export function surfPoint(s: Surf, u: number, v: number): V3 | undefined {
  switch (s.kind) {
    case 'plane':
      return s.x && s.y ? add(s.o, add(mul(s.x, u), mul(s.y, v))) : undefined;
    case 'cylinder':
      return add(s.o, add(mul(add(mul(s.x, Math.cos(u * RAD)), mul(s.y, Math.sin(u * RAD))), s.r), mul(s.z, v)));
    case 'cone':
      return add(
        s.o,
        add(mul(add(mul(s.x, Math.cos(u * RAD)), mul(s.y, Math.sin(u * RAD))), s.r + v * Math.tan(s.r2)), mul(s.z, v)),
      );
    case 'sphere': {
      const cu = Math.cos(u * RAD),
        su = Math.sin(u * RAD),
        cv = Math.cos(v * RAD),
        sv = Math.sin(v * RAD);
      return add(s.o, mul(add(mul(add(mul(s.x, cu), mul(s.y, su)), cv), mul(s.z, sv)), s.r));
    }
    case 'torus': {
      const cu = Math.cos(u * RAD),
        su = Math.sin(u * RAD),
        cv = Math.cos(v * RAD),
        sv = Math.sin(v * RAD);
      return add(s.o, add(mul(sub(mul(s.x, cv), mul(s.y, sv)), s.r + s.r2 * cu), mul(s.z, s.r2 * su)));
    }
    case 'nurbs':
      return nurbsSurfaceAt(s.s, u, v);
    case 'revolution':
      return rotateAbout(pointAt(s.curve, u), s.a, s.d, v);
    case 'extrusion': {
      const [a, b] = domain(s.curve);
      return add(pointAt(s.curve, a + u * (b - a)), mul(s.v, v));
    }
    case 'offset': {
      const p = surfPoint(s.base, u, v),
        n = surfNormal(s.base, u, v);
      return p && n ? add(p, mul(n, s.d)) : undefined;
    }
  }
}

/** The unit normal Su x Sv at (u, v), from central differences (the given normal for an unparameterized plane). */
export function surfNormal(s: Surf, u: number, v: number): V3 | undefined {
  if (s.kind === 'plane' && !(s.x && s.y)) return unit(s.n);
  const [u0, u1, v0, v1] = surfDomain(s),
    hu = Number.isFinite(u1 - u0) ? (u1 - u0) * 1e-6 : 1e-6,
    hv = Number.isFinite(v1 - v0) ? (v1 - v0) * 1e-6 : 1e-6,
    // Differences stay inside the domain: at an edge, step inwards.
    ua = Math.max(u0, u - hu),
    ub = Math.min(u1, u + hu),
    va = Math.max(v0, v - hv),
    vb = Math.min(v1, v + hv);
  const a = surfPoint(s, ua, v),
    b = surfPoint(s, ub, v),
    c = surfPoint(s, u, va),
    d = surfPoint(s, u, vb);
  if (!a || !b || !c || !d) return undefined;
  const n = cross(sub(b, a), sub(d, c));
  return len(n) > 0 ? unit(n) : undefined;
}

/** The surface under an affine map. */
export function transformSurf(s: Surf, m: Xf): Surf {
  const k = scaleOf(m),
    dir = (v: V3) => unit(rotate(m, v));
  switch (s.kind) {
    case 'plane': {
      // A normal maps with the inverse transpose; for the rigid maps IGES 124 allows that is the rotation itself.
      return {
        kind: 'plane',
        o: apply(m, s.o),
        n: s.x && s.y ? unit(cross(rotate(m, s.x), rotate(m, s.y))) : dir(s.n),
        ...(s.x && s.y ? { x: rotate(m, s.x), y: rotate(m, s.y) } : {}),
      };
    }
    case 'cylinder':
    case 'cone':
    case 'sphere':
    case 'torus':
      return {
        kind: s.kind,
        o: apply(m, s.o),
        x: dir(s.x),
        y: dir(s.y),
        z: dir(s.z),
        r: s.r * k,
        r2: s.kind === 'torus' ? s.r2 * k : s.r2,
      };
    case 'nurbs':
      return { kind: 'nurbs', dom: s.dom, s: { ...s.s, P: s.s.P.map((p) => apply(m, p)) } };
    case 'revolution':
      // A reflection turns rotations the other way: the reflected axis is reversed so angles still run forward.
      return {
        kind: 'revolution',
        a: apply(m, s.a),
        d: mul(dir(s.d), determinant(m) < 0 ? -1 : 1),
        curve: transformCurve(s.curve, m),
        sa: s.sa,
        ta: s.ta,
      };
    case 'extrusion':
      return { kind: 'extrusion', curve: transformCurve(s.curve, m), v: rotate(m, s.v) };
    case 'offset':
      return { kind: 'offset', base: transformSurf(s.base, m), d: s.d * k };
  }
}
