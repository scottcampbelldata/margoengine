// Intersections for the Boolean operations. Surface/surface: exact curves for the analytic pairs (plane with plane,
// cylinder, cone at right angles, sphere; parallel cylinders), as the textbook cases give them. Curve/surface: the
// roots of the surface's signed distance along the curve, bracketed by sampling and closed by bisection to the last
// bit, so a crossing is never missed between samples finer than the curve's turn.
import { add, cross, dot, length, scale, sub, unit, type V3 } from '../geometry/vec.js';
import { curveEvaluator, frameOf, type CurveDef, type SurfaceDef } from './geometry.js';

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

/** A bound on the curve's speed |C'(t)|, so on the signed distance's rate of change along it (distances change no faster than the point moves). */
function speedBound(curve: CurveDef): number {
  switch (curve.kind) {
    case 'line':
      return length(curve.direction);
    case 'circle':
      return curve.radius;
    case 'ellipse':
      return Math.max(curve.a, curve.b);
    default:
      return Infinity;
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

/** What two surfaces share: curves, the same surface (coincident), or nothing. */
export type SurfaceIntersection = { kind: 'curves'; curves: CurveDef[] } | { kind: 'coincident' } | { kind: 'none' };

const parallel = (a: V3, b: V3) => length(cross(a, b)) <= 1e-12;

/** Exact intersection curves of two analytic surfaces; throws a RangeError for a pair not supported yet. */
export function intersectSurfaces(a: SurfaceDef, b: SurfaceDef): SurfaceIntersection {
  if (b.kind === 'plane' && a.kind !== 'plane') return intersectSurfaces(b, a);
  if (a.kind === 'plane' && b.kind === 'plane') return planePlane(a.frame.origin, a.frame.z, b.frame.origin, b.frame.z);
  if (a.kind === 'plane') {
    const o = a.frame.origin,
      n = a.frame.z;
    if (b.kind === 'cylinder') return planeCylinder(o, n, b.frame.origin, b.frame.z, b.frame.x, b.radius);
    if (b.kind === 'sphere') {
      const d = dot(sub(b.frame.origin, o), n);
      if (Math.abs(d) >= b.radius) return { kind: 'none' };
      const centre = sub(b.frame.origin, scale(n, d));
      return {
        kind: 'curves',
        curves: [{ kind: 'circle', frame: frameOf(centre, n), radius: Math.sqrt(b.radius ** 2 - d * d) }],
      };
    }
    if (b.kind === 'cone' && parallel(n, b.frame.z)) {
      const h = dot(sub(o, b.frame.origin), b.frame.z),
        r = b.radius + h * Math.tan(b.angle);
      if (!(r > 0)) return { kind: 'none' };
      return {
        kind: 'curves',
        curves: [
          { kind: 'circle', frame: frameOf(add(b.frame.origin, scale(b.frame.z, h)), b.frame.z, b.frame.x), radius: r },
        ],
      };
    }
  }
  if (a.kind === 'cylinder' && b.kind === 'cylinder' && parallel(a.frame.z, b.frame.z))
    return parallelCylinders(a.frame.origin, a.frame.z, a.radius, b.frame.origin, b.radius);
  throw new RangeError(`Booleans between ${a.kind} and ${b.kind} faces are not supported yet`);
}

function planePlane(o1: V3, n1: V3, o2: V3, n2: V3): SurfaceIntersection {
  const direction = cross(n1, n2),
    len = length(direction);
  if (len <= 1e-12) return Math.abs(dot(sub(o2, o1), n1)) <= 1e-12 ? { kind: 'coincident' } : { kind: 'none' };
  // The point of the line nearest the origin: on both planes and perpendicular to the line.
  const d1 = dot(n1, o1),
    d2 = dot(n2, o2),
    u = scale(direction, 1 / len),
    point = scale(add(scale(cross(n2, direction), d1), scale(cross(direction, n1), d2)), 1 / (len * len));
  return { kind: 'curves', curves: [{ kind: 'line', origin: point, direction: u }] };
}

function planeCylinder(o: V3, n: V3, c: V3, axis: V3, x: V3, r: number): SurfaceIntersection {
  const along = dot(n, axis);
  if (Math.abs(along) <= 1e-12) {
    // Plane parallel to the axis: none, one tangent line or two lines along the axis.
    const d = dot(sub(c, o), n);
    if (Math.abs(d) > r) return { kind: 'none' };
    const foot = sub(c, scale(n, d)),
      half = Math.sqrt(Math.max(0, r * r - d * d)),
      across = unit(cross(n, axis))!;
    const lines: CurveDef[] = [{ kind: 'line', origin: add(foot, scale(across, half)), direction: axis }];
    if (half > 0) lines.push({ kind: 'line', origin: sub(foot, scale(across, half)), direction: axis });
    return { kind: 'curves', curves: lines };
  }
  // The axis meets the plane at the centre of a circle (at right angles) or an ellipse.
  const t = dot(sub(o, c), n) / along,
    centre = add(c, scale(axis, t));
  if (Math.abs(Math.abs(along) - 1) <= 1e-12)
    return { kind: 'curves', curves: [{ kind: 'circle', frame: frameOf(centre, n, x), radius: r }] };
  const major = unit(sub(axis, scale(n, along)))!;
  return {
    kind: 'curves',
    curves: [{ kind: 'ellipse', frame: frameOf(centre, n, major), a: r / Math.abs(along), b: r }],
  };
}

function parallelCylinders(c1: V3, axis: V3, r1: number, c2: V3, r2: number): SurfaceIntersection {
  // In the plane across the axes: two circles; their crossing points run along the axis.
  const d = sub(c2, c1),
    offset = sub(d, scale(axis, dot(d, axis))),
    gap = length(offset);
  if (gap <= 1e-12) return Math.abs(r1 - r2) <= 1e-12 ? { kind: 'coincident' } : { kind: 'none' };
  if (gap > r1 + r2 || gap < Math.abs(r1 - r2)) return { kind: 'none' };
  const ex = scale(offset, 1 / gap),
    ey = cross(axis, ex),
    a = (r1 * r1 - r2 * r2 + gap * gap) / (2 * gap),
    h = Math.sqrt(Math.max(0, r1 * r1 - a * a)),
    base = add(c1, scale(ex, a)),
    lines: CurveDef[] = [{ kind: 'line', origin: add(base, scale(ey, h)), direction: axis }];
  if (h > 0) lines.push({ kind: 'line', origin: sub(base, scale(ey, h)), direction: axis });
  return { kind: 'curves', curves: lines };
}
