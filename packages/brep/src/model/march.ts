// Intersection curves no closed form gives (cylinders at an angle, a sphere off a cylinder's axis, a plane across a
// cone or a torus), traced point by point inside a box. Seeds are where lines and circles lying on one surface cross
// the other (found by the crossing search, so none is missed along them); from each seed the curve is followed both
// ways: a step along the direction the two surfaces meet in, then Newton's method back onto both surfaces in the plane
// across the step, with the step shortened until the curve turns less than 0.08 rad over it. Every traced point lies
// on both surfaces to rounding; the curve between them is a cubic Hermite spline through the points and their exact
// tangents (deviation about 1e-11 of the step for that turn). A branch ends where it leaves the box or comes back to
// its start. Where the surfaces touch tangentially the direction is undefined: that throws a RangeError.
import { add, cross, dot, length, scale, sub, unit, type V3 } from '../geometry/vec.js';
import { curveSurfaceCrossings, distanceGradient, meetDirection, signedDistance } from './distance.js';
import { curveEvaluator, frameOf, type CurveDef, type SurfaceDef } from './geometry.js';

/** An axis-aligned box. */
export interface Box3 {
  readonly min: V3;
  readonly max: V3;
}

const MAX_TURN = 0.08;

/**
 * Curves where surfaces `a` and `b` meet inside `box` (closed loops, and branches cut where they leave it), and the
 * points where two of them cross: there the surfaces touch tangentially (two equal cylinders at right angles), and the
 * Booleans put a vertex.
 */
export function traceIntersections(a: SurfaceDef, b: SurfaceDef, box: Box3): { curves: CurveDef[]; crossings: V3[] } {
  const size = length(sub(box.max, box.min));
  if (!(size > 0)) return { curves: [], crossings: [] };
  const hmax = size / 8,
    scale0 = size + Math.max(...box.min.map(Math.abs), ...box.max.map(Math.abs)),
    branches: { points: V3[]; tangents: V3[] }[] = [],
    curves: CurveDef[] = [];
  const covered = (p: V3) =>
    branches.some(({ points, tangents }) => {
      for (let i = 0; i + 1 < points.length; i++) {
        const q = points[i],
          r = points[i + 1],
          d = sub(r, q),
          len2 = dot(d, d),
          s = len2 ? Math.max(0, Math.min(1, dot(sub(p, q), d) / len2)) : 0,
          gap = length(sub(p, add(q, scale(d, s)))),
          sag = (Math.sqrt(len2) * Math.acos(Math.min(1, Math.abs(dot(tangents[i], tangents[i + 1]))))) / 8;
        if (gap <= 1.5 * sag + 1e-9 * scale0) return true;
      }
      return false;
    });
  for (const seed of [...seeds(a, b, box), ...seeds(b, a, box)]) {
    const s = settle(a, b, seed, seed, meetDirection(a, b, seed) ?? [0, 0, 0], scale0);
    if (!s || !inside(box, s, 1e-9 * size) || covered(s)) continue;
    const t0 = meetDirection(a, b, s);
    if (!t0) throw new RangeError('the surfaces touch tangentially: Booleans there are not supported yet');
    const forward = walk(a, b, s, t0, box, hmax, scale0);
    let points = forward.points,
      tangents = forward.tangents;
    if (!forward.closed) {
      const back = walk(a, b, s, scale(t0, -1), box, hmax, scale0);
      points = [...back.points.slice(1).reverse(), ...points];
      tangents = [
        ...back.tangents
          .slice(1)
          .reverse()
          .map((t) => scale(t, -1)),
        ...tangents,
      ];
    }
    if (points.length < 2) continue;
    branches.push({ points, tangents });
    curves.push(hermite(points, tangents, forward.closed));
  }
  // Curves that meet cross where the surfaces touch tangentially (two equal cylinders at right angles): the tracer
  // steps over such a point, so it is found here, from chords that come within their sag of each other, and moved onto
  // both curves.
  const sag = (t: { points: V3[]; tangents: V3[] }, k: number) =>
      (length(sub(t.points[k + 1], t.points[k])) *
        Math.acos(Math.min(1, Math.abs(dot(t.tangents[k], t.tangents[k + 1]))))) /
      8,
    near = 1e-6 * size,
    crossings: V3[] = [];
  for (let i = 0; i < branches.length; i++)
    for (let j = i; j < branches.length; j++) {
      const p = branches[i].points,
        q = branches[j].points;
      for (let a = 0; a + 1 < p.length; a++)
        for (let b = i === j ? a + 2 : 0; b + 1 < q.length; b++) {
          if (i === j && a === 0 && b + 2 === q.length && p[0] === q[q.length - 1]) continue;
          const gap = closest(p[a], p[a + 1], q[b], q[b + 1]);
          if (gap.distance > 2 * (sag(branches[i], a) + sag(branches[j], b)) + near) continue;
          let x = scale(add(gap.p, gap.q), 0.5);
          if (i !== j) {
            const ci = curveEvaluator(curves[i]),
              cj = curveEvaluator(curves[j]);
            for (let k = 0; k < 60; k++) {
              const yi = ci.at(ci.parameter(x)).slice(0, 3) as V3,
                yj = cj.at(cj.parameter(x)).slice(0, 3) as V3;
              x = scale(add(yi, yj), 0.5);
              if (length(sub(yi, yj)) <= 1e-12 * scale0) break;
            }
          }
          if (!crossings.some((c) => length(sub(c, x)) <= near)) crossings.push(x);
        }
    }
  return { curves, crossings };
}

/** The closest points of segments pq and rs, and their distance. */
function closest(p: V3, q: V3, r: V3, s: V3): { p: V3; q: V3; distance: number } {
  const d1 = sub(q, p),
    d2 = sub(s, r),
    w = sub(p, r),
    a = dot(d1, d1),
    e = dot(d2, d2),
    f = dot(d2, w);
  let t1 = 0,
    t2 = 0;
  if (a <= 0 && e <= 0) return { p, q: r, distance: length(w) };
  if (a <= 0) t2 = Math.max(0, Math.min(1, f / e));
  else {
    const c = dot(d1, w);
    if (e <= 0) t1 = Math.max(0, Math.min(1, -c / a));
    else {
      const b = dot(d1, d2),
        den = a * e - b * b;
      t1 = den > 0 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t2 = (b * t1 + f) / e;
      if (t2 < 0) {
        t2 = 0;
        t1 = Math.max(0, Math.min(1, -c / a));
      } else if (t2 > 1) {
        t2 = 1;
        t1 = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  const x = add(p, scale(d1, t1)),
    y = add(r, scale(d2, t2));
  return { p: x, q: y, distance: length(sub(x, y)) };
}

function inside(box: Box3, p: V3, margin: number): boolean {
  for (let k = 0; k < 3; k++) if (p[k] < box.min[k] - margin || p[k] > box.max[k] + margin) return false;
  return true;
}

/** Solves [r1; r2; r3] x = rhs (Cramer's rule); undefined when singular. */
function solve3(r1: V3, r2: V3, r3: V3, rhs: V3): V3 | undefined {
  const c23 = cross(r2, r3),
    det = dot(r1, c23);
  if (!(Math.abs(det) > 1e-14)) return undefined;
  const c31 = cross(r3, r1),
    c12 = cross(r1, r2);
  // Columns of the inverse are c23, c31, c12 over det.
  return [
    (c23[0] * rhs[0] + c31[0] * rhs[1] + c12[0] * rhs[2]) / det,
    (c23[1] * rhs[0] + c31[1] * rhs[1] + c12[1] * rhs[2]) / det,
    (c23[2] * rhs[0] + c31[2] * rhs[1] + c12[2] * rhs[2]) / det,
  ];
}

/** Newton's method from `p` onto both surfaces, staying in the plane through `anchor` across `along`. */
function settle(a: SurfaceDef, b: SurfaceDef, p: V3, anchor: V3, along: V3, scale0: number): V3 | undefined {
  if (!length(along)) return undefined;
  let q = p;
  const eps = 4e-16 * scale0;
  for (let i = 0; i < 40; i++) {
    const fa = signedDistance(a, q),
      fb = signedDistance(b, q),
      fc = dot(sub(q, anchor), along);
    if (Math.abs(fa) <= eps && Math.abs(fb) <= eps && Math.abs(fc) <= eps) return q;
    const dq = solve3(distanceGradient(a, q), distanceGradient(b, q), along, [fa, fb, fc]);
    if (!dq) return undefined;
    const next = sub(q, dq);
    if (length(dq) <= 1e-15 * scale0) return next;
    q = next;
  }
  return Math.abs(signedDistance(a, q)) <= 1e-10 * scale0 && Math.abs(signedDistance(b, q)) <= 1e-10 * scale0
    ? q
    : undefined;
}

/** Follows the curve from `start` along `direction` until it leaves the box or returns to `start`. */
function walk(
  a: SurfaceDef,
  b: SurfaceDef,
  start: V3,
  direction: V3,
  box: Box3,
  hmax: number,
  scale0: number,
): { points: V3[]; tangents: V3[]; closed: boolean } {
  const points: V3[] = [start],
    tangents: V3[] = [direction];
  let h = hmax / 4,
    travelled = 0;
  for (let steps = 0; steps < 200_000; steps++) {
    const p = points[points.length - 1],
      t = tangents[tangents.length - 1];
    // Back at the start: it lies less than a step ahead, close to the way the curve is going, and the curve heads the
    // way it set off. Then the loop closes onto it.
    const toStart = sub(start, p),
      ahead = dot(toStart, t);
    if (
      points.length > 2 &&
      travelled > 2 * h &&
      ahead > 0 &&
      ahead <= 1.5 * h &&
      dot(t, direction) > 0.9 &&
      length(sub(toStart, scale(t, ahead))) <= ahead * MAX_TURN + 1e-9 * scale0
    ) {
      points.push(start);
      tangents.push(direction);
      return { points, tangents, closed: true };
    }
    const target = add(p, scale(t, h)),
      q = settle(a, b, target, target, t, scale0);
    let tq = q && meetDirection(a, b, q);
    if (q && !tq) throw new RangeError('the surfaces touch tangentially: Booleans there are not supported yet');
    if (q && tq && dot(tq, t) < 0) tq = scale(tq, -1);
    const turn = tq ? Math.acos(Math.min(1, dot(t, tq))) : Infinity;
    if (!q || !tq || turn > MAX_TURN || dot(sub(q, p), t) <= 0) {
      h /= 2;
      if (h < 1e-12 * hmax) throw new RangeError('an intersection curve could not be followed (it turns too sharply)');
      continue;
    }
    points.push(q);
    tangents.push(tq);
    travelled += length(sub(q, p));
    if (!inside(box, q, 0)) return { points, tangents, closed: false };
    if (turn < MAX_TURN / 3) h = Math.min(hmax, h * 1.5);
  }
  throw new RangeError('an intersection curve did not end within 200,000 steps');
}

/** A C1 cubic B-spline (a chain of Bezier segments) through the points with the given unit tangents. */
function hermite(points: V3[], tangents: V3[], closed: boolean): CurveDef {
  const control: V3[] = [points[0]],
    knots = [0],
    multiplicities = [4];
  let t = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const p = points[i],
      q = points[i + 1],
      len = length(sub(q, p)),
      // Handles of the best cubic for a circular arc turning this much (chord/3 when straight): deviation of order
      // turn^6 rather than turn^4.
      turn = Math.acos(Math.min(1, dot(tangents[i], tangents[i + 1]))),
      handle = turn > 1e-6 ? (2 / 3) * len * (Math.tan(turn / 4) / Math.sin(turn / 2)) : len / 3,
      arc = turn > 1e-6 ? (len * turn) / (2 * Math.sin(turn / 2)) : len;
    control.push(add(p, scale(tangents[i], handle)), sub(q, scale(tangents[i + 1], handle)), q);
    t += arc;
    knots.push(t);
    multiplicities.push(3);
  }
  multiplicities[multiplicities.length - 1] = 4;
  return {
    kind: 'spline',
    degrees: [3],
    counts: [control.length],
    knots: [knots],
    multiplicities: [multiplicities],
    points: control,
    closed,
  };
}

/** The lines and circles lying on `s` across `box`, each with its parameter range. */
function isoCurves(s: SurfaceDef, box: Box3, n: number): { curve: CurveDef; t0: number; t1: number }[] {
  const corners: V3[] = [];
  for (let i = 0; i < 8; i++)
    corners.push([i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]]);
  if (s.kind === 'spline') throw new RangeError('Booleans on spline surfaces are not supported yet');
  const { origin: o, x, y, z } = s.frame,
    range = (axis: V3) => {
      const v = corners.map((c) => dot(sub(c, o), axis));
      return [Math.min(...v), Math.max(...v)];
    },
    at = (a: number, dx: V3, b: number, dy: V3) => add(o, add(scale(dx, a), scale(dy, b))),
    out: { curve: CurveDef; t0: number; t1: number }[] = [],
    circle = (centre: V3, normal: V3, radius: number, xDir?: V3) => {
      if (radius > 0)
        out.push({ curve: { kind: 'circle', frame: frameOf(centre, normal, xDir), radius }, t0: 0, t1: 2 * Math.PI });
    },
    [h0, h1] = range(z);
  switch (s.kind) {
    case 'plane': {
      const [u0, u1] = range(x),
        [v0, v1] = range(y);
      for (let k = 0; k < n; k++) {
        const v = v0 + ((k + 0.5) * (v1 - v0)) / n,
          u = u0 + ((k + 0.5) * (u1 - u0)) / n;
        out.push({ curve: { kind: 'line', origin: at(0, x, v, y), direction: x }, t0: u0, t1: u1 });
        out.push({ curve: { kind: 'line', origin: at(u, x, 0, y), direction: y }, t0: v0, t1: v1 });
      }
      break;
    }
    case 'cylinder':
    case 'cone': {
      const tan = s.kind === 'cone' ? Math.tan(s.angle) : 0,
        cos = Math.cos(s.kind === 'cone' ? s.angle : 0);
      for (let k = 0; k < n; k++) {
        const u = (2 * Math.PI * k) / n,
          r: V3 = add(scale(x, Math.cos(u)), scale(y, Math.sin(u))),
          dir = unit(add(z, scale(r, tan)))!;
        out.push({
          curve: { kind: 'line', origin: add(o, scale(r, s.radius)), direction: dir },
          t0: h0 / cos,
          t1: h1 / cos,
        });
        const h = h0 + ((k + 0.5) * (h1 - h0)) / n;
        circle(add(o, scale(z, h)), z, s.radius + h * tan, x);
      }
      break;
    }
    case 'sphere':
      for (let k = 0; k < n; k++) {
        const h = -s.radius + ((k + 0.5) * 2 * s.radius) / n,
          u = (Math.PI * k) / n;
        circle(add(o, scale(z, h)), z, Math.sqrt(s.radius ** 2 - h * h), x);
        circle(o, add(scale(x, -Math.sin(u)), scale(y, Math.cos(u))), s.radius, z);
      }
      break;
    case 'torus':
      for (let k = 0; k < n; k++) {
        const u = (2 * Math.PI * k) / n,
          r: V3 = add(scale(x, Math.cos(u)), scale(y, Math.sin(u))),
          along: V3 = add(scale(x, -Math.sin(u)), scale(y, Math.cos(u)));
        circle(add(o, scale(r, s.major)), along, s.minor, r);
        circle(add(o, scale(z, s.minor * Math.sin(u))), z, s.major + s.minor * Math.cos(u), x);
      }
      break;
  }
  return out;
}

/** Points where curves lying on `s` cross `other`, inside the box. */
function seeds(s: SurfaceDef, other: SurfaceDef, box: Box3): V3[] {
  const margin = 1e-9 * length(sub(box.max, box.min)),
    out: V3[] = [];
  for (const { curve, t0, t1 } of isoCurves(s, box, 32))
    for (const t of curveSurfaceCrossings(curve, other, t0, t1)) {
      const c = curve.kind === 'line' ? add(curve.origin, scale(curve.direction, t)) : undefined,
        p = c ?? circlePoint(curve, t);
      if (inside(box, p, margin)) out.push(p);
    }
  return out;
}

function circlePoint(curve: CurveDef, t: number): V3 {
  if (curve.kind !== 'circle') throw new TypeError('expected a circle');
  const { origin, x, y } = curve.frame;
  return add(origin, add(scale(x, curve.radius * Math.cos(t)), scale(y, curve.radius * Math.sin(t))));
}
