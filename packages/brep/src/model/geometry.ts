// Geometry the modeler creates and edits: plain data (so it can be named, compared, transformed and saved), with the
// kernel's own evaluators behind it and a STEP writer for each kind. Lengths are metres.
import { makeCurve, type Curve } from '../geometry/curves.js';
import { knotVector } from '../geometry/nurbs.js';
import type { Frame } from '../geometry/read.js';
import { makeSurface, type Surface } from '../geometry/surfaces.js';
import { cross, dot, unit, type V3 } from '../geometry/vec.js';
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
  | { readonly kind: 'line'; readonly origin: V3; readonly direction: V3 }
  /** Counter-clockwise about frame z from frame x. */
  | { readonly kind: 'circle'; readonly frame: Frame; readonly radius: number }
  | { readonly kind: 'ellipse'; readonly frame: Frame; readonly a: number; readonly b: number }
  | ({ readonly kind: 'spline'; readonly closed?: boolean } & WriterSpline);

/** An orthonormal frame at `origin` with axis `z` and x towards `x` (any perpendicular when omitted or parallel). */
export function frameOf(origin: V3, z: V3, x?: V3): Frame {
  const zz = unit(z);
  if (!zz) throw new RangeError('frame axis must not be the zero vector');
  let xx = x ? unit([x[0] - dot(x, zz) * zz[0], x[1] - dot(x, zz) * zz[1], x[2] - dot(x, zz) * zz[2]]) : undefined;
  if (!xx) xx = unit(Math.abs(zz[0]) < 0.9 ? cross([0, 1, 0], zz) : cross([0, 0, 1], zz))!;
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

/** Writes a surface as STEP and returns its id. */
export function writeSurface(w: StepWriter, def: SurfaceDef): string {
  const place = (f: Frame) => w.axis(f.origin, f.z, f.x);
  switch (def.kind) {
    case 'plane':
      return w.add(`PLANE('',${place(def.frame)})`);
    case 'cylinder':
      return w.add(`CYLINDRICAL_SURFACE('',${place(def.frame)},${w.real(def.radius)})`);
    case 'cone':
      return w.add(`CONICAL_SURFACE('',${place(def.frame)},${w.real(def.radius)},${w.real(def.angle)})`);
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
