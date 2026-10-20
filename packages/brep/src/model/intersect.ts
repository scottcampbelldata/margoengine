// Intersections for the Boolean operations: exact curves where a closed form exists (plane with plane, plane with
// cylinder, parallel cylinders, and every pair of surfaces of revolution on one axis, which meet in circles), and
// curves traced point by point inside a box for every other pair, spline surfaces included (march.ts).
import { add, cross, dot, length, scale, sub, unit, type XYZ } from '../geometry/vec.js';
import { frameOf, type CurveDef, type SurfaceDef } from './geometry.js';
import { traceIntersections, type Box3 } from './march.js';

export { curveSurfaceCrossings, signedDistance } from './distance.js';

/** What two surfaces share: curves, the same surface (coincident), or nothing. */
export type SurfaceIntersection =
  /** `crossings`: points where two curves cross (the surfaces touch tangentially there). */
  { kind: 'curves'; curves: CurveDef[]; crossings?: XYZ[] } | { kind: 'coincident' } | { kind: 'none' };

const parallel = (a: XYZ, b: XYZ) => length(cross(a, b)) <= 1e-12;

/**
 * What two analytic surfaces share: curves, the same surface, or nothing. Exact where a closed form exists (plane with
 * plane, plane with cylinder, parallel cylinders, and surfaces of revolution on one axis: planes across it, spheres
 * centred on it, cylinders, cones and tori about it, which meet in circles); otherwise the curves are traced inside
 * `box` (march.ts), which those pairs (and every pair with a spline surface) need. Surfaces that come within
 * `tolerance` of touching (a plane or a cylinder along a cylinder, surfaces about one axis along a circle, or two
 * traced surfaces at a point) are taken to touch: one line or circle where they run alongside, crossing curves where
 * they meet at a point (the Booleans pass 1e-6 of the model). Traced surfaces touching along a curve give no curve
 * there: only the curves crossing it, traced straight through it.
 */
export function intersectSurfaces(a: SurfaceDef, b: SurfaceDef, box?: Box3, tolerance = 0): SurfaceIntersection {
  if (b.kind === 'plane' && a.kind !== 'plane') return intersectSurfaces(b, a, box, tolerance);
  if (a.kind === 'plane' && b.kind === 'plane') return planePlane(a.frame.origin, a.frame.z, b.frame.origin, b.frame.z);
  const coaxial = revolutionPair(a, b, tolerance);
  if (coaxial) return coaxial;
  if (a.kind === 'plane' && b.kind === 'cylinder')
    return planeCylinder(a.frame.origin, a.frame.z, b.frame.origin, b.frame.z, b.frame.x, b.radius, tolerance);
  if (a.kind === 'cylinder' && b.kind === 'cylinder' && parallel(a.frame.z, b.frame.z))
    return parallelCylinders(a.frame.origin, a.frame.z, a.radius, b.frame.origin, b.radius, tolerance);
  if (!box) throw new RangeError(`intersecting ${a.kind} with ${b.kind} needs a box to trace the curves in`);
  const { curves, crossings } = traceIntersections(a, b, box, tolerance || undefined);
  return curves.length ? { kind: 'curves', curves, crossings } : { kind: 'none' };
}

type Axis = { o: XYZ; z: XYZ };
type P2 = [number, number];
/** A surface of revolution's profile in its half-plane: rho (distance from the axis) and h (height along it). */
type Meridian = { kind: 'line'; p: P2; d: P2 } | { kind: 'circle'; c: P2; r: number };

const fromAxis = (axis: Axis, p: XYZ) => {
  const d = sub(p, axis.o),
    h = dot(d, axis.z);
  return { h, rho: length(sub(d, scale(axis.z, h))) };
};

/**
 * The circles two surfaces of revolution on one axis meet in; undefined when they share no axis. Within `tolerance` of
 * touching (a ball in a bore, a ring on a plane), they touch along one circle.
 */
function revolutionPair(a: SurfaceDef, b: SurfaceDef, tolerance: number): SurfaceIntersection | undefined {
  if (a.kind === 'spline' || b.kind === 'spline') return undefined;
  const size =
      1 +
      Math.max(
        ...[a, b].flatMap((s) => [
          ...s.frame.origin.map(Math.abs),
          'radius' in s ? s.radius : 0,
          'major' in s ? s.major + s.minor : 0,
        ]),
      ),
    tol = 1e-12 * size,
    fixed = (s: SurfaceDef): Axis | undefined =>
      s.kind === 'cylinder' || s.kind === 'cone' || s.kind === 'torus'
        ? { o: s.frame.origin, z: s.frame.z }
        : undefined;
  let axis = fixed(a) ?? fixed(b);
  if (!axis) {
    if (a.kind === 'plane' && b.kind === 'sphere') axis = { o: b.frame.origin, z: a.frame.z };
    else if (a.kind === 'sphere' && b.kind === 'sphere') {
      const d = sub(b.frame.origin, a.frame.origin);
      if (length(d) <= tol) return Math.abs(a.radius - b.radius) <= tol ? { kind: 'coincident' } : { kind: 'none' };
      axis = { o: a.frame.origin, z: unit(d)! };
    } else return undefined;
  }
  const about = (s: SurfaceDef & { frame: { origin: XYZ; z: XYZ } }) =>
    s.kind === 'plane'
      ? parallel(s.frame.z, axis.z)
      : s.kind === 'sphere'
        ? fromAxis(axis, s.frame.origin).rho <= tol
        : parallel(s.frame.z, axis.z) && fromAxis(axis, s.frame.origin).rho <= tol;
  if (!about(a) || !about(b)) return undefined;
  const ma = meridians(a, axis),
    mb = meridians(b, axis),
    points: P2[] = [];
  for (const m of ma)
    for (const n of mb) {
      const met = meet(m, n, tol, Math.max(tol, tolerance));
      if (met === 'same') return { kind: 'coincident' };
      for (const q of met)
        if (q[0] > tol && !points.some((r) => Math.abs(r[0] - q[0]) <= tol && Math.abs(r[1] - q[1]) <= tol))
          points.push(q);
    }
  if (!points.length) return { kind: 'none' };
  return {
    kind: 'curves',
    curves: points.map(([rho, h]) => ({
      kind: 'circle',
      frame: frameOf(add(axis.o, scale(axis.z, h)), axis.z),
      radius: rho,
    })),
  };
}

function meridians(s: SurfaceDef, axis: Axis): Meridian[] {
  if (s.kind === 'spline') return [];
  const h0 = dot(sub(s.frame.origin, axis.o), axis.z);
  switch (s.kind) {
    case 'plane':
      return [{ kind: 'line', p: [0, h0], d: [1, 0] }];
    case 'sphere':
      return [{ kind: 'circle', c: [0, h0], r: s.radius }];
    case 'cylinder':
      return [{ kind: 'line', p: [s.radius, 0], d: [0, 1] }];
    case 'torus':
      return [{ kind: 'circle', c: [s.major, h0], r: s.minor }];
    case 'cone': {
      // rho = |r0 + (h - h0) slope|: two lines in the half-plane, one per nappe.
      const slope = Math.sign(dot(s.frame.z, axis.z)) * Math.tan(s.angle),
        k = Math.hypot(slope, 1);
      return [
        { kind: 'line', p: [s.radius, h0], d: [slope / k, 1 / k] },
        { kind: 'line', p: [-s.radius, h0], d: [-slope / k, 1 / k] },
      ];
    }
  }
}

const cross2 = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];

/**
 * Where two profile curves meet ('same' when they are one curve, within `tol`). A touch gives one point, and so do curves
 * that come within `near` of touching (or of it apart): the point between them.
 */
function meet(m: Meridian, n: Meridian, tol: number, near: number): P2[] | 'same' {
  if (m.kind === 'circle' && n.kind === 'line') return meet(n, m, tol, near);
  if (m.kind === 'line' && n.kind === 'line') {
    const den = cross2(m.d, n.d),
      w: P2 = [n.p[0] - m.p[0], n.p[1] - m.p[1]];
    if (Math.abs(den) <= 1e-14) return Math.abs(cross2(w, m.d)) <= tol ? 'same' : [];
    const s = cross2(w, n.d) / den;
    return [[m.p[0] + m.d[0] * s, m.p[1] + m.d[1] * s]];
  }
  if (m.kind === 'line' && n.kind === 'circle') {
    const w: P2 = [n.c[0] - m.p[0], n.c[1] - m.p[1]],
      s0 = w[0] * m.d[0] + w[1] * m.d[1],
      off = cross2(m.d, w),
      dip = n.r - Math.abs(off),
      disc = n.r * n.r - off * off,
      at = (s: number): P2 => [m.p[0] + m.d[0] * s, m.p[1] + m.d[1] * s];
    if (dip < -near) return [];
    const half = Math.sqrt(Math.max(0, disc));
    return Math.abs(dip) <= near || half <= tol ? [at(s0)] : [at(s0 - half), at(s0 + half)];
  }
  if (m.kind === 'circle' && n.kind === 'circle') {
    const dx = n.c[0] - m.c[0],
      dy = n.c[1] - m.c[1],
      d = Math.hypot(dx, dy);
    if (d <= tol) return Math.abs(m.r - n.r) <= tol ? 'same' : [];
    if (d > m.r + n.r + near || d < Math.abs(m.r - n.r) - near) return [];
    const a = (m.r * m.r - n.r * n.r + d * d) / (2 * d),
      h = Math.sqrt(Math.max(0, m.r * m.r - a * a)),
      base: P2 = [m.c[0] + (a * dx) / d, m.c[1] + (a * dy) / d];
    return h <= tol || Math.abs(d - m.r - n.r) <= near || Math.abs(d - Math.abs(m.r - n.r)) <= near
      ? [base]
      : [
          [base[0] - (h * dy) / d, base[1] + (h * dx) / d],
          [base[0] + (h * dy) / d, base[1] - (h * dx) / d],
        ];
  }
  return [];
}

function planePlane(o1: XYZ, n1: XYZ, o2: XYZ, n2: XYZ): SurfaceIntersection {
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

function planeCylinder(o: XYZ, n: XYZ, c: XYZ, axis: XYZ, x: XYZ, r: number, tolerance: number): SurfaceIntersection {
  const along = dot(n, axis);
  if (Math.abs(along) <= 1e-12) {
    // Plane parallel to the axis: none, one tangent line or two lines along the axis.
    const d = dot(sub(c, o), n),
      // Within rounding of the radius, or the tolerance, the plane touches the cylinder along one line (a fillet
      // against its face, a drill as wide as a rib).
      touching = Math.max(1e-9 * r, tolerance);
    if (Math.abs(d) > r + touching) return { kind: 'none' };
    const foot = sub(c, scale(n, d)),
      half = Math.abs(Math.abs(d) - r) <= touching ? 0 : Math.sqrt(Math.max(0, r * r - d * d)),
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

function parallelCylinders(
  c1: XYZ,
  axis: XYZ,
  r1: number,
  c2: XYZ,
  r2: number,
  tolerance: number,
): SurfaceIntersection {
  // In the plane across the axes: two circles; their crossing points run along the axis.
  const d = sub(c2, c1),
    offset = sub(d, scale(axis, dot(d, axis))),
    gap = length(offset);
  if (gap <= 1e-12) return Math.abs(r1 - r2) <= 1e-12 ? { kind: 'coincident' } : { kind: 'none' };
  const touching = Math.max(1e-9 * Math.max(r1, r2), tolerance);
  if (gap > r1 + r2 + touching || gap < Math.abs(r1 - r2) - touching) return { kind: 'none' };
  const ex = scale(offset, 1 / gap),
    ey = cross(axis, ex),
    a = (r1 * r1 - r2 * r2 + gap * gap) / (2 * gap),
    h =
      Math.abs(gap - (r1 + r2)) <= touching || Math.abs(gap - Math.abs(r1 - r2)) <= touching
        ? 0
        : Math.sqrt(Math.max(0, r1 * r1 - a * a)),
    base = add(c1, scale(ex, a)),
    lines: CurveDef[] = [{ kind: 'line', origin: add(base, scale(ey, h)), direction: axis }];
  if (h > 0) lines.push({ kind: 'line', origin: sub(base, scale(ey, h)), direction: axis });
  return { kind: 'curves', curves: lines };
}
