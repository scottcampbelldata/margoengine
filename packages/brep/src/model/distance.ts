// Signed distances to the analytic surfaces and their gradients: the implicit form every intersection, crossing and
// in/out decision of the Booleans works from. Each is the true Euclidean distance (or, for a cone, its exact local
// form), so it changes no faster than the point moves.
import { cross, dot, length, scale, sub, unit, type XYZ } from '../geometry/vec.js';
import { curveEvaluator, type CurveDef, type SurfaceDef } from './geometry.js';

/** Signed distance from `p` to a surface along its natural normal (positive on the normal's side). */
export function signedDistance(s: SurfaceDef, p: XYZ): number {
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
function radial(frame: { origin: XYZ; x: XYZ; z: XYZ }, p: XYZ): XYZ {
  const d = sub(p, frame.origin),
    off = sub(d, scale(frame.z, dot(d, frame.z)));
  return unit(off) ?? frame.x;
}

/** Gradient of the signed distance at `p`: the unit surface normal there, on the surface's natural side. */
export function distanceGradient(s: SurfaceDef, p: XYZ): XYZ {
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
export function meetDirection(a: SurfaceDef, b: SurfaceDef, p: XYZ): XYZ | undefined {
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

/** A bound on |C''(t)|, Infinity for splines (whose knots may be corners). */
function accelerationBound(curve: CurveDef): number {
  switch (curve.kind) {
    case 'line':
      return 0;
    case 'circle':
      return curve.radius;
    case 'ellipse':
      return Math.max(curve.a, curve.b);
    case 'spline':
      return Infinity;
  }
}

/**
 * A bound on the signed distance's second derivative in any direction within `reach` of `p`: none for a plane, one
 * over the clearance from the axis or centre (or a torus's core circle) for the others, unbounded where the reach comes
 * near them.
 */
function bendBound(s: SurfaceDef, p: XYZ, reach: number): number {
  let clear: number;
  switch (s.kind) {
    case 'plane':
      return 0;
    case 'sphere':
      clear = length(sub(p, s.frame.origin));
      break;
    case 'cylinder':
    case 'cone':
    case 'torus': {
      const d = sub(p, s.frame.origin),
        h = dot(d, s.frame.z),
        rho = length(sub(d, scale(s.frame.z, h)));
      clear = s.kind === 'torus' ? Math.min(rho, Math.hypot(rho - s.major, h)) : rho;
      break;
    }
    default:
      return Infinity;
  }
  clear -= reach;
  return clear > 0 ? 1 / clear : Infinity;
}

const negative = (x: number) => x < 0;

/**
 * The root of f in [lo, hi], where f changes sign, to the last bit (or to 2^-64 of the bracket, for a root at 0 where
 * floats run finer than that): false position with the Illinois correction (the end that stays put has its value
 * halved), every fourth step a halving. A parameter where f is exactly 0 is returned as it is.
 */
function bisect(f: (t: number) => number, lo: number, flo: number, hi: number, fhi: number): number {
  const floor = (hi - lo) * 2 ** -64;
  // The end values false position works from (halved by the Illinois correction).
  let glo = flo,
    ghi = fhi,
    side = 0;
  const move = (t: number, ft: number) => {
    if (negative(ft) === negative(flo)) {
      lo = t;
      flo = glo = ft;
      if (side === 1) ghi /= 2;
      side = 1;
    } else {
      hi = t;
      fhi = ghi = ft;
      if (side === -1) glo /= 2;
      side = -1;
    }
  };
  for (let i = 0; i < 400; i++) {
    const width = hi - lo,
      mid = (lo + hi) / 2;
    if (mid <= lo || mid >= hi || width <= floor) break;
    // Every fourth step halves, so a creeping false position still closes the bracket. Otherwise the step lands at
    // least 2^-26 of the bracket inside it, so a root a rounding error from one end is closed in on in a few steps.
    const nudge = width * 2 ** -26;
    let t = i % 4 === 3 ? mid : Math.min(hi - nudge, Math.max(lo + nudge, lo - (glo * width) / (ghi - glo)));
    if (!(t > lo && t < hi)) t = mid;
    const ft = f(t);
    if (ft === 0) return t;
    move(t, ft);
  }
  return Math.abs(flo) <= Math.abs(fhi) ? lo : hi;
}

/**
 * Parameters in [t0, t1] where the curve crosses the surface (its signed distance changes sign), each found to the
 * last bit. Intervals are split until each either provably holds no crossing or is shorter than `resolution` (a
 * distance; default 1e-9 of the curve's length), so no crossing is missed however close to another; a touch counts
 * twice and stretches lying on the surface count none. An interval holds no crossing when the distance at its ends is
 * more than the curve can travel between them, or, near a touch (where the distance grows with the square of the
 * parameter and that test fails down to `resolution`), more than the distance's second derivative can bend it back by.
 */
export function curveSurfaceCrossings(
  curve: CurveDef,
  surface: SurfaceDef,
  t0: number,
  t1: number,
  resolution?: number,
): number[] {
  const c = curveEvaluator(curve),
    f = (t: number) => signedDistance(surface, c.at(t).slice(0, 3) as XYZ),
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
      if (negative(fa) !== negative(fb)) out.push(bisect(f, a, fa, b, fb));
      a = b;
      fa = fb;
    }
    return out;
  }
  const tol = resolution ?? 1e-9 * speed * (t1 - t0),
    acceleration = accelerationBound(curve);
  const visit = (a: number, fa: number, b: number, fb: number, depth: number) => {
    const change = negative(fa) !== negative(fb),
      w = b - a;
    if (!change && Math.abs(fa) + Math.abs(fb) > speed * w) return;
    if (speed * w <= tol || depth > 64) {
      if (change) out.push(bisect(f, a, fa, b, fb));
      return;
    }
    const m = (a + b) / 2,
      cm = c.at(m),
      pm = cm.slice(0, 3) as XYZ,
      fm = signedDistance(surface, pm),
      // |f''| <= k on the interval.
      k = bendBound(surface, pm, (speed * w) / 2) * speed * speed + acceleration,
      // f' stays this far from zero across it (f'(m) less what f'' can change it by over half the interval).
      slope = Math.abs(dot(distanceGradient(surface, pm), [cm[3], cm[4], cm[5]])) - (k * w) / 2;
    // Monotonic, by more than the resolution across the interval: one crossing at most.
    if (slope * w > tol) {
      if (change) out.push(bisect(f, a, fa, b, fb));
      return;
    }
    if (!change) {
      if (Math.abs(fa) <= tol && Math.abs(fm) <= tol && Math.abs(fb) <= tol) return;
      // f stays within k w^2 / 8 of the chord between its ends; ends further than that (and than the resolution) from
      // the surface, on one side, leave no crossing between them.
      if (Math.min(Math.abs(fa), Math.abs(fb)) > (k * w * w) / 8 + tol) return;
    }
    visit(a, fa, m, fm, depth + 1);
    visit(m, fm, b, fb, depth + 1);
  };
  visit(t0, f(t0), t1, f(t1), 0);
  return out;
}
