// Signed distances to the surfaces and their gradients: the implicit form every intersection, crossing and in/out
// decision of the Booleans works from. Each is the true Euclidean distance (or, for a cone, its exact local form), so
// it changes no faster than the point moves. A spline surface's is the distance to its nearest place along the normal
// there (beyond its edges, to the surface continued along that normal), found by projection from where the last
// point on it landed.
import { cross, dot, length, scale, sub, unit, type XYZ } from '../geometry/vec.js';
import { curveEvaluator, surfaceEvaluator, type CurveDef, type SurfaceDef } from './geometry.js';

/** A spline surface's control points' box, padded by a millionth of its size (the surface lies inside it). */
const boxes = new WeakMap<SurfaceDef, { min: XYZ; max: XYZ }>();
function controlBox(s: SurfaceDef & { kind: 'spline' }): { min: XYZ; max: XYZ } {
  let box = boxes.get(s);
  if (!box) {
    const min: XYZ = [Infinity, Infinity, Infinity],
      max: XYZ = [-Infinity, -Infinity, -Infinity];
    for (const p of s.points)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    const pad = 1e-6 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    box = { min: min.map((x) => x - pad) as XYZ, max: max.map((x) => x + pad) as XYZ };
    boxes.set(s, box);
  }
  return box;
}

/** Where the last point projected onto each spline surface landed: the next projection starts there. */
const lastFoot = new WeakMap<SurfaceDef, [number, number]>();

/**
 * The nearest place on a spline surface to `p`: its (u, v), point and unit normal; found from where the last point
 * landed, or (`fresh`) by the surface's own search.
 */
export function splineFoot(s: SurfaceDef, p: XYZ, fresh = false): { uv: [number, number]; q: XYZ; n: XYZ } {
  const e = surfaceEvaluator(s),
    uv = e.parameters(p, fresh ? undefined : lastFoot.get(s));
  lastFoot.set(s, uv);
  return { uv, q: e.at(uv[0], uv[1]).slice(0, 3) as XYZ, n: e.normal(uv[0], uv[1]) };
}

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
    case 'spline': {
      const { q, n } = splineFoot(s, p);
      return dot(sub(p, q), n);
    }
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
    case 'spline':
      return splineFoot(s, p).n;
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

/** The smallest radius of curvature of an analytic surface near a curve (Infinity for a plane). */
function featureSize(s: SurfaceDef, c: { at(t: number): number[] }, t0: number, t1: number): number {
  switch (s.kind) {
    case 'plane':
      return Infinity;
    case 'cylinder':
    case 'sphere':
      return s.radius;
    case 'torus':
      return s.minor;
    case 'cone': {
      // The cone's radius where the curve runs (smallest over a few of its points), not less than a millionth of it.
      let r = Infinity;
      for (let k = 0; k <= 16; k++) {
        const p = c.at(t0 + ((t1 - t0) * k) / 16),
          h = dot(sub(p.slice(0, 3) as XYZ, s.frame.origin), s.frame.z);
        r = Math.min(r, Math.abs(s.radius + h * Math.tan(s.angle)));
      }
      return Math.max(r, 1e-6 * Math.abs(s.radius) || 1e-12);
    }
    default:
      return Infinity;
  }
}

/**
 * Parameters along a spline curve over [t0, t1]: the curve's own samples where it turns a fifth of a radian, each
 * stretch then cut so neighbours lie at most `feature` / 4 apart (at least 256 in all, at most 100,000).
 */
function splineSamples(
  c: { at(t: number): number[]; sample(a: number, b: number, deflection: number, turn: number): number[] },
  t0: number,
  t1: number,
  feature: number,
): number[] {
  const base = 256,
    coarse: number[] = [];
  for (let k = 0; k <= base; k++) coarse.push(t0 + ((t1 - t0) * k) / base);
  let length = 0;
  for (let k = 1; k <= base; k++) {
    const p = c.at(coarse[k - 1]),
      q = c.at(coarse[k]);
    length += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
  }
  const turned = c.sample(t0, t1, length || 1, 0.2),
    stops = [...new Set([...coarse, ...turned])].sort((x, y) => x - y),
    out = [stops[0]],
    gap = Number.isFinite(feature) ? feature / 4 : Infinity;
  for (let k = 1; k < stops.length && out.length < 100_000; k++) {
    const a = stops[k - 1],
      b = stops[k],
      p = c.at(a),
      q = c.at(b),
      chord = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]),
      pieces = Math.min(1000, Math.max(1, Math.ceil(chord / gap)));
    for (let i = 1; i <= pieces; i++) out.push(a + ((b - a) * i) / pieces);
  }
  return out;
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
  if (surface.kind === 'spline') return splineCrossings(curve, surface, t0, t1);
  const speed = speedBound(curve);
  if (!Number.isFinite(speed)) {
    // Splines (rational ones have no simple speed bound): sign changes between samples close enough that the curve
    // cannot enter and leave the surface between two of them (a quarter of its smallest radius apart, and where the
    // curve turns a fifth of a radian), so a helix passing a drill once a turn is seen every turn.
    const ts = splineSamples(c, t0, t1, featureSize(surface, c, t0, t1));
    let a = ts[0],
      fa = f(a);
    for (let k = 1; k < ts.length; k++) {
      const b = ts[k],
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

/**
 * A spline surface as cells of its parameter grid (two to a knot span each way, up to 128 a direction), each with a
 * box round its corners, middle and edge midpoints, padded by twice the most any of them strays from the corners'
 * plane average: the surface over the cell lies inside it.
 */
interface SplineCells {
  readonly us: number[];
  readonly vs: number[];
  readonly boxes: { min: XYZ; max: XYZ }[];
}
const cellCache = new WeakMap<SurfaceDef, SplineCells>();
function splineCells(s: SurfaceDef): SplineCells {
  let cells = cellCache.get(s);
  if (cells) return cells;
  const e = surfaceEvaluator(s),
    [ub, vb] = e.breaks?.() ?? [[], []],
    params = (breaks: readonly number[], domain: readonly [number, number]) => {
      const knots = breaks.length >= 2 ? breaks : domain,
        per = Math.max(1, Math.min(2, Math.floor(128 / Math.max(1, knots.length - 1)))),
        out: number[] = [];
      for (let i = 1; i < knots.length; i++)
        for (let k = 0; k < per; k++) out.push(knots[i - 1] + ((knots[i] - knots[i - 1]) * k) / per);
      out.push(knots[knots.length - 1]);
      return out;
    },
    us = params(ub, e.uDomain),
    vs = params(vb, e.vDomain),
    at = (u: number, v: number) => e.at(u, v).slice(0, 3) as XYZ,
    grid = us.map((u) => vs.map((v) => at(u, v))),
    boxes: { min: XYZ; max: XYZ }[] = [];
  for (let i = 0; i + 1 < us.length; i++)
    for (let j = 0; j + 1 < vs.length; j++) {
      const corners = [grid[i][j], grid[i + 1][j], grid[i][j + 1], grid[i + 1][j + 1]],
        um = (us[i] + us[i + 1]) / 2,
        vm = (vs[j] + vs[j + 1]) / 2,
        inner = [at(um, vm), at(um, vs[j]), at(um, vs[j + 1]), at(us[i], vm), at(us[i + 1], vm)],
        mean = [0, 1, 2].map((k) => corners.reduce((a, c) => a + c[k], 0) / 4) as XYZ,
        min: XYZ = [Infinity, Infinity, Infinity],
        max: XYZ = [-Infinity, -Infinity, -Infinity];
      let stray = 0;
      for (const q of inner) stray = Math.max(stray, length(sub(q, mean)) - length(sub(corners[0], mean)), 0);
      for (const q of [...corners, ...inner])
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], q[k]);
          max[k] = Math.max(max[k], q[k]);
        }
      const pad = 2 * stray + 1e-9 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) + 1e-15;
      boxes.push({ min: min.map((x) => x - pad) as XYZ, max: max.map((x) => x + pad) as XYZ });
    }
  cells = { us, vs, boxes };
  cellCache.set(s, cells);
  return cells;
}

/**
 * Where a curve crosses a spline surface (not tangentially), every sheet of it: the curve in pieces (one for a line,
 * 64 otherwise), each piece's padded box against the surface's cells, and Newton's method on S(u, v) = C(t) from each
 * cell a piece's box meets. Roots outside the domain or the parameter range are dropped; nearby ones are merged.
 */
function splineCrossings(curve: CurveDef, surface: SurfaceDef, t0: number, t1: number): number[] {
  const c = curveEvaluator(curve),
    e = surfaceEvaluator(surface),
    cells = splineCells(surface),
    nv = cells.vs.length - 1,
    pieces = curve.kind === 'line' ? 1 : 64,
    scale0 = length(
      sub(
        controlBox(surface as SurfaceDef & { kind: 'spline' }).max,
        controlBox(surface as SurfaceDef & { kind: 'spline' }).min,
      ),
    ),
    roots: number[] = [],
    meets = (a: { min: XYZ; max: XYZ }, b: { min: XYZ; max: XYZ }) =>
      a.min[0] <= b.max[0] &&
      b.min[0] <= a.max[0] &&
      a.min[1] <= b.max[1] &&
      b.min[1] <= a.max[1] &&
      a.min[2] <= b.max[2] &&
      b.min[2] <= a.max[2];
  for (let k = 0; k < pieces; k++) {
    const a = t0 + ((t1 - t0) * k) / pieces,
      b = t0 + ((t1 - t0) * (k + 1)) / pieces;
    let box: { min: XYZ; max: XYZ };
    if (curve.kind === 'line') {
      const p = c.at(a),
        q = c.at(b);
      box = {
        min: [0, 1, 2].map((i) => Math.min(p[i], q[i])) as XYZ,
        max: [0, 1, 2].map((i) => Math.max(p[i], q[i])) as XYZ,
      };
    } else {
      const p = c.at(a).slice(0, 3) as XYZ,
        q = c.at(b).slice(0, 3) as XYZ,
        m = c.at((a + b) / 2).slice(0, 3) as XYZ,
        sag = 2 * length(sub(m, scale(add3(p, q), 0.5)));
      box = {
        min: [0, 1, 2].map((i) => Math.min(p[i], q[i], m[i]) - sag) as XYZ,
        max: [0, 1, 2].map((i) => Math.max(p[i], q[i], m[i]) + sag) as XYZ,
      };
    }
    for (let i = 0; i < cells.boxes.length; i++) {
      const cell = cells.boxes[i];
      if (!meets(box, cell)) continue;
      // Newton on F(u, v, t) = S(u, v) - C(t) from the cell's middle and the piece's middle.
      let u = (cells.us[Math.floor(i / nv)] + cells.us[Math.floor(i / nv) + 1]) / 2,
        v = (cells.vs[i % nv] + cells.vs[(i % nv) + 1]) / 2,
        t = (a + b) / 2,
        found = false;
      for (let it = 0; it < 40; it++) {
        const s = e.at(u, v),
          q = c.at(t),
          f: XYZ = [s[0] - q[0], s[1] - q[1], s[2] - q[2]];
        if (length(f) <= 1e-13 * scale0) {
          found = true;
          break;
        }
        const step = solve3t([s[3], s[4], s[5]], [s[6], s[7], s[8]], [-q[3], -q[4], -q[5]], f);
        if (!step) break;
        u -= step[0];
        v -= step[1];
        t -= step[2];
        if (!Number.isFinite(u + v + t)) break;
      }
      if (!found) continue;
      const span = (d: readonly [number, number]) => 1e-9 * (d[1] - d[0]);
      if (!e.uPeriod && (u < e.uDomain[0] - span(e.uDomain) || u > e.uDomain[1] + span(e.uDomain))) continue;
      if (!e.vPeriod && (v < e.vDomain[0] - span(e.vDomain) || v > e.vDomain[1] + span(e.vDomain))) continue;
      if (t < t0 - 1e-12 * (t1 - t0) || t > t1 + 1e-12 * (t1 - t0)) continue;
      if (!roots.some((r) => Math.abs(r - t) <= 1e-9 * (t1 - t0))) roots.push(t);
    }
  }
  return roots.sort((x, y) => x - y);
}

const add3 = (a: readonly number[], b: readonly number[]): XYZ => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Solves x c1 + y c2 + z c3 = rhs (columns), by Cramer's rule; undefined when singular. */
function solve3t(c1: XYZ, c2: XYZ, c3: XYZ, rhs: XYZ): XYZ | undefined {
  const det = dot(c1, cross(c2, c3));
  if (!(Math.abs(det) > 1e-300)) return undefined;
  return [dot(rhs, cross(c2, c3)) / det, dot(c1, cross(rhs, c3)) / det, dot(c1, cross(c2, rhs)) / det];
}
