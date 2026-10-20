// Geometry the modeler creates and edits: plain data (so it can be named, compared, transformed and saved), with the
// kernel's own evaluators behind it and a STEP writer for each kind. Lengths are metres.
import { makeCurve, type Curve } from '../geometry/curves.js';
import { knotVector } from '../geometry/nurbs.js';
import type { Frame } from '../geometry/read.js';
import { makeSurface, type Surface } from '../geometry/surfaces.js';
import { cross, dot, scale, unit, type XYZ } from '../geometry/vec.js';
import type { StepWriter, WriterSpline } from '../step/write.js';

export type { Frame };

/** A surface: its kind and defining values. Every surface's natural normal is Su x Sv. */
export type SurfaceDef =
  | { readonly kind: 'plane'; readonly frame: Frame }
  /** Normal pointing away from the axis. */
  | { readonly kind: 'cylinder'; readonly frame: Frame; readonly radius: number }
  /** Radius at the frame origin, growing along +z by tan(angle). */
  | { readonly kind: 'cone'; readonly frame: Frame; readonly radius: number; readonly angle: number }
  | { readonly kind: 'sphere'; readonly frame: Frame; readonly radius: number }
  | { readonly kind: 'torus'; readonly frame: Frame; readonly major: number; readonly minor: number }
  | ({ readonly kind: 'spline'; readonly uClosed?: boolean; readonly vClosed?: boolean } & WriterSpline);

/** A curve: its kind and defining values. */
export type CurveDef =
  /** `direction` is a unit vector; the parameter is the distance from `origin`. */
  | { readonly kind: 'line'; readonly origin: XYZ; readonly direction: XYZ }
  /** Counter-clockwise about frame z from frame x. */
  | { readonly kind: 'circle'; readonly frame: Frame; readonly radius: number }
  | { readonly kind: 'ellipse'; readonly frame: Frame; readonly a: number; readonly b: number }
  | ({ readonly kind: 'spline'; readonly closed?: boolean } & WriterSpline);

/** An orthonormal frame at `origin` with axis `z` and x towards `x` (any perpendicular when omitted or parallel). */
export function frameOf(origin: XYZ, z: XYZ, x?: XYZ): Frame {
  const zz = unit(z);
  if (!zz) throw new RangeError('frame axis must not be the zero vector');
  let xx = x ? unit([x[0] - dot(x, zz) * zz[0], x[1] - dot(x, zz) * zz[1], x[2] - dot(x, zz) * zz[2]]) : undefined;
  // (An axis along y crosses y to nothing: then x is taken across the x axis instead.)
  if (!xx)
    xx = unit(Math.abs(zz[0]) < 0.9 ? cross([0, 1, 0], zz) : cross([0, 0, 1], zz)) ?? unit(cross([1, 0, 0], zz))!;
  return { origin, x: xx, y: cross(zz, xx), z: zz };
}

const surfaceCache = new WeakMap<SurfaceDef, Surface>(),
  curveCache = new WeakMap<CurveDef, Curve>();

/** The kernel evaluator of a surface (cached per definition object). */
export function surfaceEvaluator(def: SurfaceDef): Surface {
  let s = surfaceCache.get(def);
  if (s) return s;
  switch (def.kind) {
    case 'plane':
      s = makeSurface.plane(def.frame);
      break;
    case 'cylinder':
      s = makeSurface.cone(def.frame, def.radius, 0);
      break;
    case 'cone':
      s = makeSurface.cone(def.frame, def.radius, def.angle);
      break;
    case 'sphere':
      s = makeSurface.sphere(def.frame, def.radius);
      break;
    case 'torus':
      s = makeSurface.torus(def.frame, def.major, def.minor);
      break;
    case 'spline': {
      const [nu, nv] = def.counts,
        points = new Float64Array(nu * nv * 4);
      // The writer's order has u fastest; the evaluator's control net has u outer.
      for (let i = 0; i < nu; i++)
        for (let j = 0; j < nv; j++) {
          const k = j * nu + i,
            p = def.points[k],
            w = def.weights?.[k] ?? 1;
          points.set([p[0] * w, p[1] * w, p[2] * w, w], (i * nv + j) * 4);
        }
      s = makeSurface.spline(
        {
          uDegree: def.degrees[0],
          vDegree: def.degrees[1],
          nu,
          nv,
          points,
          uKnots: knotVector(def.knots[0], def.multiplicities[0]),
          vKnots: knotVector(def.knots[1], def.multiplicities[1]),
        },
        !!def.uClosed,
        !!def.vClosed,
      );
      break;
    }
  }
  surfaceCache.set(def, s);
  return s;
}

/** The kernel evaluator of a curve (cached per definition object). */
export function curveEvaluator(def: CurveDef): Curve {
  let c = curveCache.get(def);
  if (c) return c;
  switch (def.kind) {
    case 'line':
      c = makeCurve.line(def.origin, def.direction);
      break;
    case 'circle':
      c = makeCurve.ellipse(def.frame, def.radius, def.radius);
      break;
    case 'ellipse':
      c = makeCurve.ellipse(def.frame, def.a, def.b);
      break;
    case 'spline': {
      const n = def.points.length,
        points = new Float64Array(n * 4);
      def.points.forEach((p, k) => {
        const w = def.weights?.[k] ?? 1;
        points.set([p[0] * w, p[1] * w, p[2] * w, w], k * 4);
      });
      c = makeCurve.spline(
        { degree: def.degrees[0], points, knots: knotVector(def.knots[0], def.multiplicities[0]) },
        !!def.closed,
      );
      break;
    }
  }
  curveCache.set(def, c);
  return c;
}

/**
 * The stretch [a, b] of a B-spline curve as a curve of its own, exactly (knots inserted at a and b until the curve
 * passes through its control points there, Boehm's algorithm, in homogeneous coordinates for rational curves). On a
 * closed curve b may run past the domain's end: the two stretches either side of its seam are joined. Other curves
 * are returned as they are.
 */
export function sliceCurve(def: CurveDef, a: number, b: number): CurveDef {
  if (def.kind !== 'spline') return def;
  const p = def.degrees[0],
    U0 = def.knots[0].flatMap((k, i) => Array<number>(def.multiplicities[0][i]).fill(k)),
    lo = U0[p],
    hi = U0[U0.length - 1 - p];
  if (def.closed) {
    // On a closed curve the stretch may start a period off (a piece joined across the curve's start): moved to start
    // in the first period, it runs past the end at most once.
    const period = hi - lo,
      k = Math.floor((a - lo) / period + 1e-12);
    a -= k * period;
    b -= k * period;
    if (b > hi + 1e-12 * period) {
      const first = sliceCurve({ ...def, closed: false }, a, hi),
        second = sliceCurve({ ...def, closed: false }, lo, b - period);
      return joinSplines(first, second);
    }
  }
  let U = [...U0],
    P = def.points.map((q, i) => {
      const w = def.weights?.[i] ?? 1;
      return [q[0] * w, q[1] * w, q[2] * w, w];
    });
  // Boehm: one more knot at t.
  const insert = (t: number) => {
    let k = p;
    while (k + 1 < U.length - p - 1 && U[k + 1] <= t) k++;
    const Q: number[][] = [];
    for (let i = 0; i <= P.length; i++) {
      if (i <= k - p) Q.push(P[i]);
      else if (i > k) Q.push(P[i - 1]);
      else {
        const alpha = (t - U[i]) / (U[i + p] - U[i]);
        Q.push(P[i].map((x, c) => alpha * x + (1 - alpha) * P[i - 1][c]));
      }
    }
    P = Q;
    U = [...U.slice(0, k + 1), t, ...U.slice(k + 1)];
  };
  for (const t of [a, b]) {
    const clamp = Math.min(hi, Math.max(lo, t));
    while (U.filter((x) => x === clamp).length < p) insert(clamp);
  }
  const ca = Math.min(hi, Math.max(lo, a)),
    cb = Math.min(hi, Math.max(lo, b)),
    lastA = U.lastIndexOf(ca),
    firstB = U.indexOf(cb),
    ctrl = P.slice(lastA - p, firstB),
    inner = U.slice(lastA + 1, firstB),
    rational = def.weights !== undefined,
    knots: number[] = [],
    multiplicities: number[] = [];
  for (const t of [ca, ...inner, cb]) {
    if (knots.length && knots[knots.length - 1] === t) multiplicities[multiplicities.length - 1]++;
    else {
      knots.push(t);
      multiplicities.push(1);
    }
  }
  multiplicities[0] = p + 1;
  multiplicities[multiplicities.length - 1] = p + 1;
  return {
    kind: 'spline',
    degrees: [p],
    counts: [ctrl.length],
    knots: [knots],
    multiplicities: [multiplicities],
    points: ctrl.map((q) => [q[0] / q[3], q[1] / q[3], q[2] / q[3]] as XYZ),
    ...(rational ? { weights: ctrl.map((q) => q[3]) } : {}),
  };
}

/** Two clamped B-splines of one degree, the second starting where the first ends, as one (a corner allowed there). */
function joinSplines(first: CurveDef, second: CurveDef): CurveDef {
  if (first.kind !== 'spline' || second.kind !== 'spline') return first;
  const p = first.degrees[0],
    k1 = first.knots[0],
    m1 = first.multiplicities[0],
    k2 = second.knots[0],
    m2 = second.multiplicities[0],
    shift = k1[k1.length - 1] - k2[0],
    rational = first.weights !== undefined || second.weights !== undefined;
  return {
    kind: 'spline',
    degrees: [p],
    counts: [first.points.length + second.points.length - 1],
    knots: [[...k1, ...k2.slice(1).map((t) => t + shift)]],
    multiplicities: [[...m1.slice(0, -1), p, ...m2.slice(1)]],
    points: [...first.points, ...second.points.slice(1)],
    ...(rational
      ? {
          weights: [
            ...(first.weights ?? first.points.map(() => 1)),
            ...(second.weights ?? second.points.map(() => 1)).slice(1),
          ],
        }
      : {}),
  };
}

/** Writes a surface as STEP and returns its id. */
export function writeSurface(w: StepWriter, def: SurfaceDef): string {
  const place = (f: Frame) => w.axis(f.origin, f.z, f.x);
  switch (def.kind) {
    case 'plane':
      return w.add(`PLANE('',${place(def.frame)})`);
    case 'cylinder':
      return w.add(`CYLINDRICAL_SURFACE('',${place(def.frame)},${w.real(def.radius)})`);
    case 'cone':
      // STEP's semi-angle is positive (ISO 10303-42): a cone narrowing along +z is written with its axis reversed,
      // which keeps its points and its outward normal.
      return def.angle >= 0
        ? w.add(`CONICAL_SURFACE('',${place(def.frame)},${w.real(def.radius)},${w.real(def.angle)})`)
        : w.add(
            `CONICAL_SURFACE('',${w.axis(def.frame.origin, scale(def.frame.z, -1), def.frame.x)},${w.real(def.radius)},${w.real(-def.angle)})`,
          );
    case 'sphere':
      return w.add(`SPHERICAL_SURFACE('',${place(def.frame)},${w.real(def.radius)})`);
    case 'torus':
      return w.add(`TOROIDAL_SURFACE('',${place(def.frame)},${w.real(def.major)},${w.real(def.minor)})`);
    case 'spline':
      return w.spline(def);
  }
}

/** Writes a curve as STEP and returns its id. */
export function writeCurve(w: StepWriter, def: CurveDef): string {
  switch (def.kind) {
    case 'line':
      return w.add(`LINE('',${w.point(def.origin)},${w.add(`VECTOR('',${w.direction(def.direction)},1.)`)})`);
    case 'circle':
      return w.add(`CIRCLE('',${w.axis(def.frame.origin, def.frame.z, def.frame.x)},${w.real(def.radius)})`);
    case 'ellipse':
      return w.add(
        `ELLIPSE('',${w.axis(def.frame.origin, def.frame.z, def.frame.x)},${w.real(def.a)},${w.real(def.b)})`,
      );
    case 'spline':
      return w.spline(def);
  }
}
