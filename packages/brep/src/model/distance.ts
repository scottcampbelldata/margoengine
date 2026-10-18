// Signed distances to the analytic surfaces and their gradients: the implicit form every intersection, crossing and
// in/out decision of the Booleans works from. Each is the true Euclidean distance (or, for a cone, its exact local
// form), so it changes no faster than the point moves.
import { cross, dot, length, scale, sub, unit, type V3 } from '../geometry/vec.js';
import { curveEvaluator, type CurveDef, type SurfaceDef } from './geometry.js';

/** Signed distance from `p` to a surface along its natural normal (positive on the normal's side). */
export function signedDistance(s: SurfaceDef, p: V3): number {
  switch (s.kind) {
    case 'plane':
      return dot(sub(p, s.frame.origin), s.frame.z);
    case 'cylinder': {
      const d = sub(p, s.frame.origin),
        h = dot(d, s.frame.z);
      return length(sub(d, scale(s.frame.z, h))) - s.radius;
    }
    case 'sphere':
      return length(sub(p, s.frame.origin)) - s.radius;
    case 'cone': {
      const d = sub(p, s.frame.origin),
        h = dot(d, s.frame.z),
        rho = length(sub(d, scale(s.frame.z, h))),
        r = s.radius + h * Math.tan(s.angle);
      return (rho - r) * Math.cos(s.angle);
    }
    case 'torus': {
      const d = sub(p, s.frame.origin),
        h = dot(d, s.frame.z),
        rho = length(sub(d, scale(s.frame.z, h)));
      return Math.hypot(rho - s.major, h) - s.minor;
    }
    default:
      throw new RangeError(`Booleans on ${s.kind} surfaces are not supported yet`);
  }
}

/** Unit vector from the axis towards p, perpendicular to the axis (any perpendicular on the axis itself). */
function radial(frame: { origin: V3; x: V3; z: V3 }, p: V3): V3 {
  const d = sub(p, frame.origin),
    off = sub(d, scale(frame.z, dot(d, frame.z)));
  return unit(off) ?? frame.x;
}

/** Gradient of the signed distance at `p`: the unit surface normal there, on the surface's natural side. */
export function distanceGradient(s: SurfaceDef, p: V3): V3 {
  switch (s.kind) {
    case 'plane':
      return s.frame.z;
    case 'cylinder':
      return radial(s.frame, p);
    case 'sphere':
      return unit(sub(p, s.frame.origin)) ?? s.frame.z;
    case 'cone': {
      const r = radial(s.frame, p),
        c = Math.cos(s.angle),
        n = Math.sin(s.angle);
      return [c * r[0] - n * s.frame.z[0], c * r[1] - n * s.frame.z[1], c * r[2] - n * s.frame.z[2]];
    }
    case 'torus': {
      const r = radial(s.frame, p),
        centre = [
          s.frame.origin[0] + s.major * r[0],
          s.frame.origin[1] + s.major * r[1],
          s.frame.origin[2] + s.major * r[2],
        ];
      return unit(sub(p, centre)) ?? s.frame.z;
    }
    default:
      throw new RangeError(`Booleans on ${s.kind} surfaces are not supported yet`);
  }
}

/** The unit direction of the curve two surfaces meet in at `p` (undefined where they touch tangentially). */
export function meetDirection(a: SurfaceDef, b: SurfaceDef, p: V3): V3 | undefined {
  const t = cross(distanceGradient(a, p), distanceGradient(b, p));
  return length(t) > 1e-9 ? unit(t) : undefined;
}

/** A bound on the curve's speed |C'(t)|, so on the signed distance's rate of change along it (distances change no faster than the point moves). */
function speedBound(curve: CurveDef): number {
  switch (curve.kind) {
    case 'line':
      return length(curve.direction);
    case 'circle':
      return curve.radius;
    case 'ellipse':
      return Math.max(curve.a, curve.b);
    case 'spline': {
      // A non-rational B-spline's derivative is a B-spline whose control points bound its speed.
      if (curve.weights) return Infinity;
      const p = curve.degrees[0],
        U = curve.knots[0].flatMap((k, i) => Array<number>(curve.multiplicities[0][i]).fill(k)),
        P = curve.points;
      let bound = 0;
      for (let i = 0; i + 1 < P.length; i++) {
        const span = U[i + p + 1] - U[i + 1];
        if (span > 0) bound = Math.max(bound, (p * length(sub(P[i + 1], P[i]))) / span);
      }
      return bound;
    }
  }
}

const negative = (x: number) => x < 0;

/** The root of f in [lo, hi], where f changes sign, to the last bit. */
function bisect(f: (t: number) => number, lo: number, flo: number, hi: number): number {
  let fhi = f(hi);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (mid <= lo || mid >= hi) break;
    const fm = f(mid);
    if (negative(fm) === negative(flo)) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
      fhi = fm;
    }
  }
  return Math.abs(flo) <= Math.abs(fhi) ? lo : hi;
}

/**
 * Parameters in [t0, t1] where the curve crosses the surface (its signed distance changes sign), each found to the
 * last bit. Intervals are split until each either provably holds no crossing (the distance at its ends is more than
 * the curve can travel between them) or is shorter than `resolution` (a distance; default 1e-9 of the curve's
 * length), so no crossing is missed however close to another; a touch counts twice and stretches lying on the
 * surface count none.
 */
export function curveSurfaceCrossings(
  curve: CurveDef,
  surface: SurfaceDef,
  t0: number,
  t1: number,
  resolution?: number,
): number[] {
  const c = curveEvaluator(curve),
    f = (t: number) => signedDistance(surface, c.at(t).slice(0, 3) as V3),
    out: number[] = [];
  if (!(t1 > t0)) return out;
  const speed = speedBound(curve);
  if (!Number.isFinite(speed)) {
    // Splines: sign changes between dense samples.
    const n = 256;
    let a = t0,
      fa = f(a);
    for (let k = 1; k <= n; k++) {
      const b = t0 + ((t1 - t0) * k) / n,
        fb = f(b);
      if (negative(fa) !== negative(fb)) out.push(bisect(f, a, fa, b));
      a = b;
      fa = fb;
    }
    return out;
  }
  const tol = resolution ?? 1e-9 * speed * (t1 - t0);
  const visit = (a: number, fa: number, b: number, fb: number, depth: number) => {
    const change = negative(fa) !== negative(fb);
    if (!change && Math.abs(fa) + Math.abs(fb) > speed * (b - a)) return;
    if (speed * (b - a) <= tol || depth > 64) {
      if (change) out.push(bisect(f, a, fa, b));
      return;
    }
    const m = (a + b) / 2,
      fm = f(m);
    if (!change && Math.abs(fa) <= tol && Math.abs(fm) <= tol && Math.abs(fb) <= tol) return;
    visit(a, fa, m, fm, depth + 1);
    visit(m, fm, b, fb, depth + 1);
  };
  visit(t0, f(t0), t1, f(t1), 0);
  return out;
}
