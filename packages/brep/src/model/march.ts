// Intersection curves no closed form gives (cylinders at an angle, a sphere off a cylinder's axis, a plane across a
// cone or a torus), traced point by point inside a box. Seeds are where lines and circles lying on one surface cross
// the other (found by the crossing search, so none is missed along them); from each seed the curve is followed both
// ways: a step along the direction the two surfaces meet in, then Newton's method back onto both surfaces in the plane
// across the step, with the step shortened until the curve turns less than 0.08 rad over it. Every traced point lies
// on both surfaces to rounding; the curve between them is a cubic Hermite spline through the points and their exact
// tangents (deviation about 1e-11 of the step for that turn). A branch ends where it leaves the box or comes back to
// its start. Where the surfaces touch at a point, or come within the tolerance of touching there, their curves cross in
// an X (or pass each other a hair apart): a walk heading into that point finds it (where the normals are parallel,
// midway between the surfaces), puts a point there and carries straight on along the X, as through an exact touch.
// Where the surfaces come a little further than the tolerance from touching, the curves passing each other there are
// followed round their turns: near such a point no step is longer than a quarter of the distance to it.
// Where the walk lands exactly on such a point the direction is undefined: that throws a RangeError.
import { add, cross, dot, length, scale, sub, unit, type XYZ } from '../geometry/vec.js';
import { curveSurfaceCrossings, distanceGradient, meetDirection, signedDistance, splineFoot } from './distance.js';
import { curveEvaluator, frameOf, surfaceEvaluator, type CurveDef, type SurfaceDef } from './geometry.js';

/** An axis-aligned box. */
export interface Box3 {
  readonly min: XYZ;
  readonly max: XYZ;
}

const MAX_TURN = 0.08;

/**
 * Where two surfaces touch at a point, or come within the tolerance of touching there: `x` midway between them, `gap`
 * their distance apart there, `arms` the two directions in their common tangent plane along which their heights agree
 * (the X their curves make through an exact touch; undefined where the surfaces curve apart every way, and only kiss),
 * and `width` how far from `x` curves that only pass each other (a near touch) turn away from those arms, or the loop
 * round a near kiss reaches. Zero width is an exact touch.
 */
interface Touch {
  x: XYZ;
  gap: number;
  arms: [XYZ, XYZ] | undefined;
  width: number;
}

/** What a walk needs to know besides its surfaces: the box, its longest step, its scale, and what counts as a touch. */
interface Reach {
  box: Box3;
  hmax: number;
  scale0: number;
  /** How close the surfaces must come to count as touching. */
  tolerance: number;
  /** The step of the central differences that find a touch's curvatures. */
  delta: number;
}

/**
 * Curves where surfaces `a` and `b` meet inside `box` (closed loops, and branches cut where they leave it), and the
 * points where two of them cross: there the surfaces touch tangentially (two equal cylinders at right angles), and the
 * Booleans put a vertex. Surfaces that come within `tolerance` of touching at a point (1e-6 of the box unless given)
 * are taken to touch there: their curves cross there too, or, where the surfaces curve apart every way (they kiss), the
 * loop round the point is dropped (they only touch). Where they come further apart than that, the curves passing each
 * other there are traced apart, however close.
 */
export function traceIntersections(
  a: SurfaceDef,
  b: SurfaceDef,
  box: Box3,
  tolerance?: number,
): { curves: CurveDef[]; crossings: XYZ[] } {
  const size = length(sub(box.max, box.min));
  if (!(size > 0)) return { curves: [], crossings: [] };
  const hmax = size / 8,
    scale0 = size + Math.max(...box.min.map(Math.abs), ...box.max.map(Math.abs)),
    near = 1e-6 * size,
    reach: Reach = { box, hmax, scale0, tolerance: tolerance ?? near, delta: 1e-6 * size };
  // A seed settled past a spline's edge lies on its continuation: its walk would trace a curve already found again, or
  // run out and back to the edge.
  const past = (s: SurfaceDef, p: XYZ) =>
    s.kind === 'spline' && length(sub(p, splineFoot(s, p, true).q)) > 1e-10 * scale0;
  const trace = (known: Touch[], missed: Touch[]) => {
    const branches: { points: XYZ[]; tangents: XYZ[] }[] = [],
      curves: CurveDef[] = [],
      touches = [...known],
      misses = [...missed],
      kisses: Touch[] = [];
    const covered = (p: XYZ) => {
      // Within a few steps of a near touch the curves traced through it run along its arms, which the curves passing
      // each other there leave by about width^2 over the distance from it.
      let slack = 0;
      for (const { x, width } of touches)
        if (width > 0) slack += (2 * width * width) / Math.max(width, length(sub(p, x)));
      return branches.some(({ points, tangents }) => {
        for (let i = 0; i + 1 < points.length; i++) {
          const q = points[i],
            r = points[i + 1],
            d = sub(r, q),
            len2 = dot(d, d),
            s = len2 ? Math.max(0, Math.min(1, dot(sub(p, q), d) / len2)) : 0,
            gap = length(sub(p, add(q, scale(d, s)))),
            sag = (Math.sqrt(len2) * Math.acos(Math.min(1, Math.abs(dot(tangents[i], tangents[i + 1]))))) / 8;
          if (gap <= 1.5 * sag + 1e-9 * scale0 + slack) return true;
        }
        return false;
      });
    };
    for (const seed of [...seeds(a, b, box), ...seeds(b, a, box)]) {
      const s = settle(a, b, seed, seed, meetDirection(a, b, seed) ?? [0, 0, 0], scale0);
      if (!s || !inside(box, s, 1e-9 * size) || covered(s) || past(a, s) || past(b, s)) continue;
      // A seed where curves passing each other at a near touch turn (known, or found from a seed where the normals are
      // near parallel): the curves through it are walked from elsewhere, straight through the touch. Where the surfaces
      // come further apart than the tolerance (a near miss), the walk from it follows the turn in short steps.
      if (
        !touches.some(({ x, width }) => length(sub(s, x)) < 10 * width) &&
        !misses.some(({ x, width }) => length(sub(s, x)) < 10 * width) &&
        apart(a, b, s) < 0.5
      ) {
        const touch = touchPoint(a, b, s, reach.delta, scale0);
        if (touch && touch.width > 0 && inside(box, touch.x, 0)) {
          if (touch.arms && Math.abs(touch.gap) <= reach.tolerance) touches.push(touch);
          else if (Math.abs(touch.gap) > reach.tolerance) miss(misses, touch, reach);
        }
      }
      if (touches.some(({ x, width }) => length(sub(s, x)) < 10 * width)) continue;
      if (kisses.some(({ x, width }) => length(sub(s, x)) <= 2 * width + near)) continue;
      const t0 = meetDirection(a, b, s);
      if (!t0) throw new RangeError('the surfaces touch tangentially: Booleans there are not supported yet');
      const forward = walk(a, b, s, t0, reach, touches, misses);
      if (forward.lost) continue;
      let points = forward.points,
        tangents = forward.tangents;
      // A loop round a point where the surfaces kiss, as close as the tolerance (or an exact kiss, traced round a
      // loop of rounding errors): they only touch there, and no curve runs between them.
      if (forward.closed) {
        const middle = scale(points.reduce(add, [0, 0, 0] as XYZ), 1 / points.length),
          kiss = points.every((p) => length(sub(p, middle)) <= 1e-2 * size)
            ? touchPoint(a, b, middle, reach.delta, scale0)
            : undefined;
        if (
          kiss &&
          !kiss.arms &&
          Math.abs(kiss.gap) <= reach.tolerance &&
          points.every((p) => length(sub(p, kiss.x)) <= 2 * kiss.width + near)
        ) {
          kisses.push(kiss);
          continue;
        }
      }
      if (!forward.closed) {
        const back = walk(a, b, s, scale(t0, -1), reach, touches, misses);
        if (back.lost) continue;
        points = [...back.points.slice(1).reverse(), ...points];
        tangents = [
          ...back.tangents
            .slice(1)
            .reverse()
            .map((t) => scale(t, -1)),
          ...tangents,
        ];
      }
      if (points.length < 2 || points.every((p) => length(sub(p, points[0])) === 0)) continue;
      branches.push({ points, tangents });
      curves.push(hermite(points, tangents, forward.closed));
    }
    return { branches, curves, touches, misses };
  };
  // A seed walked before a near touch was found may lie where the curves passing each other there turn, and its walk
  // follow one round the turn: traced again knowing every near touch, no walk starts there. A walk that passed a near
  // miss before it was found may have stepped from one curve onto the other: traced again, every walk keeps its steps
  // short there.
  let traced = trace([], []);
  if (traced.touches.some(({ width }) => width > 0) || traced.misses.length)
    traced = trace(traced.touches, traced.misses);
  const { branches, curves, touches } = traced;
  // Curves that meet cross where the surfaces touch tangentially (two equal cylinders at right angles): the tracer
  // steps over such a point, so it is found here, from chords that come within their sag of each other, and moved onto
  // both curves.
  const sag = (t: { points: XYZ[]; tangents: XYZ[] }, k: number) =>
      (length(sub(t.points[k + 1], t.points[k])) *
        Math.acos(Math.min(1, Math.abs(dot(t.tangents[k], t.tangents[k + 1]))))) /
      8,
    crossings: XYZ[] = [];
  // The touches the walks went through are crossings of their curves (where the curves pass each other a hair apart,
  // the only one there: the walks went straight through it).
  for (const { x } of touches) if (!crossings.some((c) => length(sub(c, x)) <= near)) crossings.push(x);
  for (let i = 0; i < branches.length; i++)
    for (let j = i; j < branches.length; j++) {
      const p = branches[i].points,
        q = branches[j].points;
      for (let a = 0; a + 1 < p.length; a++)
        for (let b = i === j ? a + 2 : 0; b + 1 < q.length; b++) {
          if (i === j && a === 0 && b + 2 === q.length && p[0] === q[q.length - 1]) continue;
          const gap = closest(p[a], p[a + 1], q[b], q[b + 1]);
          if (gap.distance > 2 * (sag(branches[i], a) + sag(branches[j], b)) + near) continue;
          // Curves that cross meet at an angle; chords lying along each other (two curves running a hair apart where
          // the surfaces nearly touch, or one curve traced twice) are not a crossing.
          const da = unit(sub(p[a + 1], p[a])),
            db = unit(sub(q[b + 1], q[b]));
          if (da && db && Math.abs(dot(da, db)) > Math.cos(0.05)) continue;
          let x = scale(add(gap.p, gap.q), 0.5);
          // Onto both curves (both passes of one curve that crosses itself), from the chords that met.
          const di = curves[i],
            dj = curves[j],
            ci = curveEvaluator(di),
            cj = curveEvaluator(dj),
            ki = di.kind === 'spline' ? di.knots[0] : undefined,
            kj = dj.kind === 'spline' ? dj.knots[0] : undefined;
          let ti = ki ? (ki[a] + ki[a + 1]) / 2 : undefined,
            tj = kj ? (kj[b] + kj[b + 1]) / 2 : undefined;
          for (let k = 0; k < 60; k++) {
            ti = ci.parameter(x, ti);
            tj = cj.parameter(x, tj);
            const yi = ci.at(ti).slice(0, 3) as XYZ,
              yj = cj.at(tj).slice(0, 3) as XYZ;
            x = scale(add(yi, yj), 0.5);
            if (length(sub(yi, yj)) <= 1e-12 * scale0) break;
          }
          if (!crossings.some((c) => length(sub(c, x)) <= near)) crossings.push(x);
        }
    }
  return { curves, crossings };
}

/** The closest points of segments pq and rs, and their distance. */
function closest(p: XYZ, q: XYZ, r: XYZ, s: XYZ): { p: XYZ; q: XYZ; distance: number } {
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

function inside(box: Box3, p: XYZ, margin: number): boolean {
  for (let k = 0; k < 3; k++) if (p[k] < box.min[k] - margin || p[k] > box.max[k] + margin) return false;
  return true;
}

/** Solves [r1; r2; r3] x = rhs (Cramer's rule); undefined when singular. */
function solve3(r1: XYZ, r2: XYZ, r3: XYZ, rhs: XYZ): XYZ | undefined {
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
function settle(a: SurfaceDef, b: SurfaceDef, p: XYZ, anchor: XYZ, along: XYZ, scale0: number): XYZ | undefined {
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

/** The sine of the angle between the normals of `a` and `b` at `p`. */
function apart(a: SurfaceDef, b: SurfaceDef, p: XYZ): number {
  return length(cross(distanceGradient(a, p), distanceGradient(b, p)));
}

/**
 * The point near `guess` where the normals of `a` and `b` are parallel, midway between the surfaces (where the gap
 * between them is least, or greatest, or a saddle): Newton's method on the normals' mismatch across their common normal
 * (its rate of change there, the difference of the surfaces' curvatures, by central differences over `delta`), and on
 * the distances along it. Undefined when it does not settle, or when the surfaces curve alike along some direction
 * (they touch along a line there).
 */
function touchPoint(a: SurfaceDef, b: SurfaceDef, guess: XYZ, delta: number, scale0: number): Touch | undefined {
  let x = guess;
  for (let i = 0; i < 40; i++) {
    const ga = distanceGradient(a, x),
      gb = distanceGradient(b, x),
      sign = dot(ga, gb) < 0 ? -1 : 1,
      mismatch = (p: XYZ) => sub(distanceGradient(a, p), scale(distanceGradient(b, p), sign)),
      n = unit(add(ga, scale(gb, sign)));
    if (!n) return undefined;
    const e1 = unit(cross(n, Math.abs(n[0]) < 0.6 ? [1, 0, 0] : [0, 1, 0]))!,
      e2 = cross(n, e1),
      rate = (e: XYZ) =>
        scale(sub(mismatch(add(x, scale(e, delta))), mismatch(sub(x, scale(e, delta)))), 1 / (2 * delta)),
      c1 = rate(e1),
      c2 = rate(e2),
      // The curvature difference across the normal, [p q; q r].
      p = dot(e1, c1),
      q = (dot(e1, c2) + dot(e2, c1)) / 2,
      r = dot(e2, c2),
      det = p * r - q * q;
    if (!(Math.abs(det) > 0)) return undefined;
    const m = sub(ga, scale(gb, sign)),
      m1 = dot(e1, m),
      m2 = dot(e2, m),
      fa = signedDistance(a, x),
      fb = sign * signedDistance(b, x),
      step = add(add(scale(e1, (q * m2 - r * m1) / det), scale(e2, (q * m1 - p * m2) / det)), scale(n, -(fa + fb) / 2));
    x = add(x, step);
    if (length(step) > 1e-15 * scale0 && i < 39) continue;
    if (length(step) > 1e-12 * scale0) return undefined;
    // The surfaces' heights over the common tangent plane differ by gap + u.D.u / 2: where that is zero, along the arms
    // of an X when D's eigenvalues have opposite signs; with a gap the curves turn off them about sqrt(2 gap / |l|) out.
    // With eigenvalues of one sign the surfaces kiss: a loop that far out at most, or no curve at all.
    const mean = (p + r) / 2,
      dev = Math.sqrt(((p - r) / 2) ** 2 + q * q),
      l1 = mean + dev,
      l2 = mean - dev,
      angle = Math.atan2(2 * q, p - r) / 2,
      v1 = add(scale(e1, Math.cos(angle)), scale(e2, Math.sin(angle))),
      v2 = add(scale(e1, -Math.sin(angle)), scale(e2, Math.cos(angle))),
      gap = signedDistance(a, x) - sign * signedDistance(b, x),
      width = Math.sqrt((2 * Math.abs(gap)) / Math.min(Math.abs(l1), Math.abs(l2)));
    if (!(l1 > 0 && l2 < 0)) return { x, gap, arms: undefined, width };
    return {
      x,
      gap,
      arms: [
        unit(add(scale(v1, Math.sqrt(-l2)), scale(v2, Math.sqrt(l1))))!,
        unit(sub(scale(v1, Math.sqrt(-l2)), scale(v2, Math.sqrt(l1))))!,
      ],
      width,
    };
  }
  return undefined;
}

/**
 * Adds `touch` to the near misses unless the same point is there already, or the curves passing each other there are
 * further apart than a walk's longest step (none steps from one onto the other).
 */
function miss(misses: Touch[], touch: Touch, { hmax, scale0 }: Reach): void {
  if (touch.width >= hmax) return;
  if (!misses.some(({ x, width }) => length(sub(x, touch.x)) <= 0.1 * width + 1e-9 * scale0)) misses.push(touch);
}

/**
 * Follows the curve from `start` along `direction` until it leaves the box or returns to `start`, straight through
 * every touch it heads into (adding those it finds to `touches`). Lost when `start` lies where curves passing each
 * other at such a touch turn: walking straight through it, the walk never comes back there. Near a point where the
 * surfaces come further apart than the tolerance from touching (a near miss: known, or found as a touch is, and added
 * to `misses`), the curves passing each other there are a few widths apart: no step is longer than a quarter of the
 * walk's distance from it (or of its width), so none lands on the other curve, and the walk follows the turn.
 */
function walk(
  a: SurfaceDef,
  b: SurfaceDef,
  start: XYZ,
  direction: XYZ,
  reach: Reach,
  touches: Touch[],
  misses: Touch[],
): { points: XYZ[]; tangents: XYZ[]; closed: boolean; lost?: boolean } {
  const { box, hmax, scale0, tolerance, delta } = reach,
    points: XYZ[] = [start],
    tangents: XYZ[] = [direction],
    // How far each point's normals are from parallel: falling to zero ahead, the surfaces touch there.
    sines: number[] = [apart(a, b, start)],
    tried: XYZ[] = [];
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
    // A touch less than a step and a half ahead, on the way the curve is going: known, or found where the normals'
    // sine, falling as it is, would reach zero.
    const toward = (touch: Touch) => {
        const d = sub(touch.x, p),
          ahead = dot(d, t);
        return ahead > 0 && ahead <= 1.5 * h && length(sub(d, scale(t, ahead))) <= 0.25 * ahead + 10 * touch.width;
      },
      k = points.length - 1;
    let touch = touches.find(toward);
    if (!touch && k > 0 && sines[k] < sines[k - 1]) {
      const guess = add(p, scale(t, (sines[k] * length(sub(p, points[k - 1]))) / (sines[k - 1] - sines[k])));
      if (dot(sub(guess, p), t) <= 1.5 * h && !tried.some((y) => length(sub(y, guess)) <= h)) {
        tried.push(guess);
        const found = touchPoint(a, b, guess, delta, scale0);
        if (found && inside(box, found.x, 0) && toward(found)) {
          if (found.arms && Math.abs(found.gap) <= tolerance) touch = found;
          else if (Math.abs(found.gap) > tolerance) miss(misses, found, reach);
        }
      }
    }
    for (const { x, width } of misses) h = Math.min(h, Math.max(width, length(sub(x, p))) / 4);
    if (touch?.arms) {
      // Out along the arm nearest the way the curve is going, as far past the touch as the curve is short of it (and
      // clear of where curves passing each other there turn), and onto both surfaces there.
      const arm = touch.arms.reduce((e, f) => (Math.abs(dot(f, t)) > Math.abs(dot(e, t)) ? f : e)),
        along = dot(arm, t) < 0 ? scale(arm, -1) : arm;
      let d = Math.max(dot(sub(touch.x, p), t), 10 * touch.width),
        past: { q: XYZ; tq: XYZ } | undefined;
      for (let i = 0; i < 3 && !past; i++, d *= 2) {
        const target = add(touch.x, scale(along, d)),
          q = settle(a, b, target, target, along, scale0);
        let tq = q && meetDirection(a, b, q);
        if (!q || !tq || edgeExit(a, b, q, scale0) || edgeExit(b, a, q, scale0)) continue;
        if (dot(tq, along) < 0) tq = scale(tq, -1);
        if (Math.acos(Math.min(1, dot(tq, along))) <= 2 * MAX_TURN && dot(sub(q, touch.x), along) > 0) past = { q, tq };
      }
      if (past) {
        if (!touches.includes(touch)) touches.push(touch);
        if (length(sub(start, touch.x)) < 10 * touch.width) return { points, tangents, closed: false, lost: true };
        points.push(touch.x, past.q);
        tangents.push(along, past.tq);
        sines.push(apart(a, b, touch.x), apart(a, b, past.q));
        travelled += length(sub(touch.x, p)) + length(sub(past.q, touch.x));
        if (!inside(box, past.q, 0)) return { points, tangents, closed: false };
        continue;
      }
    }
    const target = add(p, scale(t, h)),
      q = settle(a, b, target, target, t, scale0),
      normals = q && cross(distanceGradient(a, q), distanceGradient(b, q)),
      sine = normals ? length(normals) : 0;
    let tq = normals && sine > 1e-9 ? scale(normals, 1 / sine) : undefined;
    if (q && !tq) throw new RangeError('the surfaces touch tangentially: Booleans there are not supported yet');
    if (q && tq && dot(tq, t) < 0) tq = scale(tq, -1);
    const turn = tq ? Math.acos(Math.min(1, dot(t, tq))) : Infinity;
    if (!q || !tq || turn > MAX_TURN || dot(sub(q, p), t) <= 0) {
      h /= 2;
      if (h < 1e-12 * hmax) throw new RangeError('an intersection curve could not be followed (it turns too sharply)');
      continue;
    }
    // Past a spline surface's edge (its domain's bound) the curve runs on that surface's continuation, with a kink at
    // the edge: it ends on the edge instead, exactly.
    const exit = edgeExit(a, b, q, scale0) ?? edgeExit(b, a, q, scale0);
    if (exit) {
      // From a start on the edge itself, the first step out comes back to it: nothing to add.
      if (length(sub(exit, p)) > 1e-12 * scale0) {
        const te = meetDirection(a, b, exit);
        points.push(exit);
        tangents.push(te ? (dot(te, t) < 0 ? scale(te, -1) : te) : tq);
      }
      return { points, tangents, closed: false };
    }
    points.push(q);
    tangents.push(tq);
    sines.push(sine);
    travelled += length(sub(q, p));
    if (!inside(box, q, 0)) return { points, tangents, closed: false };
    if (turn < MAX_TURN / 3) h = Math.min(hmax, h * 1.5);
  }
  throw new RangeError('an intersection curve did not end within 200,000 steps');
}

/**
 * Where a curve on spline surface `s` and on `other` that has stepped past an edge of `s` (a bound of its domain, not
 * a periodic seam) to `q` meets that edge: the root of `other`'s distance along the edge's boundary curve, from where
 * `q`'s nearest place on `s` lies on it. Undefined when `s` is not a spline, `q` lies on it, or no root is found.
 */
function edgeExit(s: SurfaceDef, other: SurfaceDef, q: XYZ, scale0: number): XYZ | undefined {
  if (s.kind !== 'spline') return undefined;
  let foot = splineFoot(s, q);
  if (length(sub(q, foot.q)) <= 1e-10 * scale0) return undefined;
  // Found from the last place, the foot may lie on another sheet: the surface's own search decides.
  foot = splineFoot(s, q, true);
  if (length(sub(q, foot.q)) <= 1e-10 * scale0) return undefined;
  const e = surfaceEvaluator(s),
    [u, v] = foot.uv,
    at = (lo: number, hi: number, x: number) =>
      Math.abs(x - lo) <= 1e-9 * (hi - lo) || Math.abs(x - hi) <= 1e-9 * (hi - lo),
    onU = !e.uPeriod && at(e.uDomain[0], e.uDomain[1], u),
    onV = !e.vPeriod && at(e.vDomain[0], e.vDomain[1], v);
  if (!onU && !onV) return undefined;
  // Along the edge: v runs at fixed u (or u at fixed v).
  const [lo, hi] = onU ? e.vDomain : e.uDomain,
    point = (t: number) => (onU ? e.at(u, t) : e.at(t, v));
  let t = onU ? v : u,
    x: XYZ | undefined;
  for (let i = 0; i < 40; i++) {
    const d = point(t),
      p = d.slice(0, 3) as XYZ,
      g = signedDistance(other, p),
      speed = dot(distanceGradient(other, p), onU ? [d[6], d[7], d[8]] : [d[3], d[4], d[5]]);
    x = p;
    if (Math.abs(g) <= 4e-16 * scale0) return x;
    if (!speed) return undefined;
    t = Math.min(hi, Math.max(lo, t - g / speed));
  }
  return x && Math.abs(signedDistance(other, x)) <= 1e-10 * scale0 ? x : undefined;
}

/** A C1 cubic B-spline (a chain of Bezier segments) through the points with the given unit tangents. */
function hermite(allPoints: XYZ[], allTangents: XYZ[], closed: boolean): CurveDef {
  // Points a rounding error apart would make a knot span of zero length.
  const keep = allPoints.map((p, i) => i === 0 || length(sub(p, allPoints[i - 1])) > 0),
    points = allPoints.filter((_, i) => keep[i]),
    tangents = allTangents.filter((_, i) => keep[i]);
  const control: XYZ[] = [points[0]],
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
  const corners: XYZ[] = [];
  for (let i = 0; i < 8; i++)
    corners.push([i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]]);
  if (s.kind === 'spline') throw new RangeError('Booleans on spline surfaces are not supported yet');
  const { origin: o, x, y, z } = s.frame,
    range = (axis: XYZ) => {
      const v = corners.map((c) => dot(sub(c, o), axis));
      return [Math.min(...v), Math.max(...v)];
    },
    at = (a: number, dx: XYZ, b: number, dy: XYZ) => add(o, add(scale(dx, a), scale(dy, b))),
    out: { curve: CurveDef; t0: number; t1: number }[] = [],
    circle = (centre: XYZ, normal: XYZ, radius: number, xDir?: XYZ) => {
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
          r: XYZ = add(scale(x, Math.cos(u)), scale(y, Math.sin(u))),
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
          r: XYZ = add(scale(x, Math.cos(u)), scale(y, Math.sin(u))),
          along: XYZ = add(scale(x, -Math.sin(u)), scale(y, Math.cos(u)));
        circle(add(o, scale(r, s.major)), along, s.minor, r);
        circle(add(o, scale(z, s.minor * Math.sin(u))), z, s.major + s.minor * Math.cos(u), x);
      }
      break;
  }
  return out;
}

/** Points where curves lying on `s` cross `other`, inside the box. */
function seeds(s: SurfaceDef, other: SurfaceDef, box: Box3): XYZ[] {
  if (s.kind === 'spline') return splineSeeds(s, other, box);
  const margin = 1e-9 * length(sub(box.max, box.min)),
    out: XYZ[] = [];
  for (const { curve, t0, t1 } of isoCurves(s, box, 32))
    for (const t of curveSurfaceCrossings(curve, other, t0, t1)) {
      const c = curve.kind === 'line' ? add(curve.origin, scale(curve.direction, t)) : undefined,
        p = c ?? circlePoint(curve, t);
      if (inside(box, p, margin)) out.push(p);
    }
  return out;
}

function circlePoint(curve: CurveDef, t: number): XYZ {
  if (curve.kind !== 'circle') throw new TypeError('expected a circle');
  const { origin, x, y } = curve.frame;
  return add(origin, add(scale(x, curve.radius * Math.cos(t)), scale(y, curve.radius * Math.sin(t))));
}

/**
 * Points where a spline surface's lines of constant u and of constant v cross `other`, inside the box: four lines to a
 * knot span each way (16 to 256), each sampled eight times a span (64 to 1024), sign changes bisected along the line.
 */
function splineSeeds(s: SurfaceDef, other: SurfaceDef, box: Box3): XYZ[] {
  const e = surfaceEvaluator(s),
    [uBreaks, vBreaks] = e.breaks?.() ?? [[], []],
    margin = 1e-9 * length(sub(box.max, box.min)),
    out: XYZ[] = [],
    params = (breaks: readonly number[], domain: readonly [number, number], per: number, lo: number, hi: number) => {
      const spans = Math.max(1, breaks.length - 1),
        n = Math.max(lo, Math.min(hi, spans * per)),
        [a, b] = breaks.length >= 2 ? [breaks[0], breaks[breaks.length - 1]] : domain;
      return Array.from({ length: n + 1 }, (_, k) => a + ((b - a) * k) / n);
    },
    us = params(uBreaks, e.uDomain, 4, 16, 256),
    vs = params(vBreaks, e.vDomain, 4, 16, 256),
    alongU = params(uBreaks, e.uDomain, 8, 64, 1024),
    alongV = params(vBreaks, e.vDomain, 8, 64, 1024),
    line = (point: (t: number) => XYZ, ts: number[]) => {
      const f = (t: number) => signedDistance(other, point(t));
      let a = ts[0],
        fa = f(a);
      for (let k = 1; k < ts.length; k++) {
        const b = ts[k],
          fb = f(b);
        if (fa < 0 !== fb < 0) {
          // Bisection to the last bit along the line, then onto both surfaces by the tracer's settle.
          let lo = a,
            hi = b,
            flo = fa;
          for (let i = 0; i < 80 && hi - lo > 1e-15 * (Math.abs(lo) + Math.abs(hi) + 1); i++) {
            const m = (lo + hi) / 2,
              fm = f(m);
            if (fm < 0 === flo < 0) {
              lo = m;
              flo = fm;
            } else hi = m;
          }
          const p = point((lo + hi) / 2);
          if (inside(box, p, margin)) out.push(p);
        }
        a = b;
        fa = fb;
      }
    };
  for (const u of us) line((v) => e.at(u, v).slice(0, 3) as XYZ, alongV);
  for (const v of vs) line((u) => e.at(u, v).slice(0, 3) as XYZ, alongU);
  return out;
}
