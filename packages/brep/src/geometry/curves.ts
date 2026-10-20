// Edge curves (ISO 10303-42): line, circle, ellipse, B-spline (rational or not) and polyline, plus the wrappers that
// name a 3D curve (surface, seam and intersection curves, trimmed curves). Each evaluates a point and tangent, finds
// the parameter of a point on it, and samples a parameter range to a chord deflection and turning angle.
import { Enum, type STEPFile, type STEPValue } from '../step/file.js';
import { clamped, curveAt, knotVector, spanBreaks, type SplineCurve } from './nurbs.js';
import { frame, list, num, point, ref, unsupported, vector } from './read.js';
import { add, angle, distance, dot, scale, sub, type XYZ } from './vec.js';

/** A 3D curve. */
export interface Curve {
  /** Period of a closed curve (circle, ellipse, closed B-spline); 0 for an open one. */
  readonly period: number;
  /** Parameter range (infinite for a line; one period for a circle or ellipse). */
  readonly domain: readonly [number, number];
  /** Point and tangent at t: [x, y, z, dx, dy, dz]. */
  at(t: number): number[];
  /** The parameter of `p`, a point on (or very near) the curve; `hint` is a nearby parameter. */
  parameter(p: readonly number[], hint?: number): number;
  /** Parameters from a to b (either order, both included) whose chords stay within `deflection` and turn by at most `turn`. */
  sample(a: number, b: number, deflection: number, turn: number): number[];
}

/** The largest angle step that keeps a circle of radius r within the chord deflection and turn. */
export const angleStep = (radius: number, deflection: number, turn: number): number =>
  radius > deflection ? Math.min(turn, 2 * Math.acos(1 - deflection / radius)) : turn;

const uniform = (a: number, b: number, step: number): number[] => {
  const n = Math.max(1, Math.min(4096, Math.ceil(Math.abs(b - a) / step - 1e-9)));
  return Array.from({ length: n + 1 }, (_, i) => (i === n ? b : a + ((b - a) * i) / n));
};

/**
 * Adaptive sampling between the break parameters `breaks` (a, ..., b): a segment splits while its midpoint strays from
 * the chord by more than `deflection`, its quarter points do, or its end tangents turn by more than `turn` while it is
 * longer than a hundredth of the deflection. Where a curve's speed falls to zero (a fillet's B-spline end) the tangent
 * direction is noise: splitting on it piled samples micrometres apart, which two faces then kept differently.
 */
function adaptive(curve: Curve, breaks: readonly number[], deflection: number, turn: number): number[] {
  const out = [breaks[0]];
  const split = (t0: number, a: number[], t1: number, b: number[], depth: number) => {
    const tm = (t0 + t1) / 2,
      m = curve.at(tm),
      chord = (k: number) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k],
      far =
        distance(m, chord(0.5)) > deflection ||
        distance(curve.at(t0 + (t1 - t0) / 4), chord(0.25)) > deflection ||
        distance(curve.at(t0 + ((t1 - t0) * 3) / 4), chord(0.75)) > deflection ||
        (distance(a, b) > deflection * 0.01 && angle(a.slice(3), b.slice(3)) > turn);
    if (far && depth < 14) {
      split(t0, a, tm, m, depth + 1);
      split(tm, m, t1, b, depth + 1);
    } else out.push(t1);
  };
  for (let i = 1; i < breaks.length; i++)
    if (breaks[i] !== breaks[i - 1]) split(breaks[i - 1], curve.at(breaks[i - 1]), breaks[i], curve.at(breaks[i]), 0);
  return out;
}
const ordered = (a: number, b: number, sample: (lo: number, hi: number) => number[]) =>
  a <= b ? sample(a, b) : sample(b, a).reverse();

class Line implements Curve {
  readonly period = 0;
  readonly domain = [-Infinity, Infinity] as const;
  constructor(
    private readonly origin: XYZ,
    private readonly dir: XYZ,
  ) {}
  at(t: number) {
    return [...add(this.origin, scale(this.dir, t)), ...this.dir];
  }
  parameter(p: readonly number[]) {
    return dot(sub(p, this.origin), this.dir) / dot(this.dir, this.dir);
  }
  sample(a: number, b: number) {
    return [a, b];
  }
}

class Ellipse implements Curve {
  readonly period = 2 * Math.PI;
  readonly domain = [0, 2 * Math.PI] as const;
  constructor(
    private readonly f: { origin: XYZ; x: XYZ; y: XYZ },
    private readonly a: number,
    private readonly b: number,
  ) {}
  at(t: number) {
    const c = Math.cos(t),
      s = Math.sin(t),
      { origin: o, x, y } = this.f,
      a = this.a,
      b = this.b;
    return [
      o[0] + a * c * x[0] + b * s * y[0],
      o[1] + a * c * x[1] + b * s * y[1],
      o[2] + a * c * x[2] + b * s * y[2],
      -a * s * x[0] + b * c * y[0],
      -a * s * x[1] + b * c * y[1],
      -a * s * x[2] + b * c * y[2],
    ];
  }
  parameter(p: readonly number[]) {
    const d = sub(p, this.f.origin),
      t = Math.atan2(dot(d, this.f.y) / this.b, dot(d, this.f.x) / this.a);
    return t < 0 ? t + 2 * Math.PI : t;
  }
  sample(a: number, b: number, deflection: number, turn: number) {
    return uniform(a, b, angleStep(Math.max(this.a, this.b), deflection, turn));
  }
}

class Spline implements Curve {
  readonly period: number;
  readonly domain: readonly [number, number];
  private readonly breaks: number[];
  private seeds?: { t: number; p: number[] }[];
  private extent?: [number, number];
  /** The farthest apart two neighbouring samples lie. */
  private step = 0;
  constructor(
    private readonly spline: SplineCurve,
    closed: boolean,
  ) {
    const n = spline.points.length / 4 - 1;
    this.domain = [spline.knots[spline.degree], spline.knots[n + 1]];
    this.breaks = spanBreaks(spline.knots, spline.degree, n);
    this.period = closed ? this.domain[1] - this.domain[0] : 0;
  }
  private clamp(t: number) {
    const [lo, hi] = this.domain;
    if (this.period) return lo + ((((t - lo) % this.period) + this.period) % this.period);
    return Math.min(hi, Math.max(lo, t));
  }
  at(t: number) {
    return curveAt(this.spline, this.clamp(t));
  }
  parameter(p: readonly number[], hint?: number) {
    // Newton on |C(t) - p| from the hint. From a hint near the point (an eighth of the longest control-polygon leg) it
    // finds the nearest place there; from a far one (the other end of an edge) it can settle on a wrong turn of a curve
    // that comes back near itself (a helix), so it is kept only when it lands within a millionth of the curve's size,
    // else the samples decide.
    if (hint !== undefined) {
      const r = this.newton(p, hint);
      if (r.start <= this.hull()[1] / 8 || r.miss <= 1e-6 * this.size()) return r.t;
      return this.nearest(p, r).t;
    }
    return this.nearest(p, { t: this.domain[0], miss: Infinity, start: Infinity }).t;
  }
  /**
   * From the samples nearest the point that are each nearer than their neighbours (one per stretch of the curve that
   * passes the point: one per turn of a helix), nearest first, until one lands or the rest lie farther than the best
   * found plus a sample step.
   */
  private nearest(
    p: readonly number[],
    best: { t: number; miss: number; start: number },
  ): { t: number; miss: number; start: number } {
    const seeds = this.samples(),
      n = seeds.length,
      d = new Float64Array(n);
    let nearest = 0;
    for (let i = 0; i < n; i++) {
      d[i] = distance(seeds[i].p, p);
      if (d[i] < d[nearest]) nearest = i;
    }
    // Most points land from the nearest sample. A tolerant vertex lies a little off the curve; a wrong turn of a helix
    // misses by its pitch, a few hundredths of the curve's size: within a thousandth is taken as landed.
    const first = this.newton(p, seeds[nearest].t);
    if (first.miss < best.miss) best = first;
    if (best.miss <= 1e-3 * this.size()) return best;
    const minima: number[] = [];
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? d[i - 1] : this.period ? d[n - 1] : Infinity,
        next = i + 1 < n ? d[i + 1] : this.period ? d[0] : Infinity;
      if (d[i] <= prev && d[i] <= next) minima.push(i);
    }
    minima.sort((a, b) => d[a] - d[b]);
    for (const i of minima.slice(0, 16)) {
      if (i === nearest) continue;
      if (best.miss <= 1e-9 * this.size() || d[i] > best.miss + this.step) break;
      const r = this.newton(p, seeds[i].t);
      if (r.miss < best.miss) best = r;
    }
    return best;
  }
  /** 8 samples per knot span and the domain's end. */
  private samples(): { t: number; p: number[] }[] {
    if (!this.seeds) {
      this.seeds = [
        ...this.breaks.slice(1).flatMap((b, i) => {
          const a = this.breaks[i];
          return Array.from({ length: 8 }, (_, k) => {
            const s = a + ((b - a) * k) / 8;
            return { t: s, p: this.at(s) };
          });
        }),
        { t: this.domain[1], p: this.at(this.domain[1]) },
      ];
      for (let i = 1; i < this.seeds.length; i++)
        this.step = Math.max(this.step, distance(this.seeds[i - 1].p, this.seeds[i].p));
    }
    return this.seeds;
  }
  /** The diagonal of the control points' box (the curve lies inside it). */
  private size(): number {
    return this.hull()[0];
  }
  /** The control points' box diagonal and longest control-polygon leg, found once. */
  private hull(): [number, number] {
    if (!this.extent) {
      const q = this.spline.points,
        lo = [Infinity, Infinity, Infinity],
        hi = [-Infinity, -Infinity, -Infinity];
      let leg = 0,
        prev: number[] | undefined;
      for (let i = 0; i < q.length; i += 4) {
        const c = [q[i] / q[i + 3], q[i + 1] / q[i + 3], q[i + 2] / q[i + 3]];
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], c[k]);
          hi[k] = Math.max(hi[k], c[k]);
        }
        if (prev) leg = Math.max(leg, distance(prev, c));
        prev = c;
      }
      this.extent = [Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1, leg];
    }
    return this.extent;
  }
  private newton(p: readonly number[], from: number): { t: number; miss: number; start: number } {
    let t = this.clamp(from),
      start = Infinity;
    for (let i = 0; i < 40; i++) {
      const c = this.at(t),
        d = c.slice(3),
        dd = dot(d, d);
      if (i === 0) start = distance(c, p);
      if (!dd) break;
      const step = dot(sub(c, p), d) / dd,
        next = this.clamp(t - step);
      if (Math.abs(next - t) < 1e-14 * Math.max(1, Math.abs(t))) {
        t = next;
        break;
      }
      t = next;
    }
    return { t, miss: distance(this.at(t), p), start };
  }
  sample(a: number, b: number, deflection: number, turn: number) {
    return ordered(a, b, (lo, hi) => {
      const inner = this.breaks.filter((k) => k > lo && k < hi),
        // Break also where a periodic range passes the domain end (the curve's knots repeat each period).
        shift = this.period ? Math.floor((lo - this.domain[0]) / this.period) * this.period : 0;
      if (this.period)
        for (const k of this.breaks)
          for (const s of [shift, shift + this.period]) if (k + s > lo && k + s < hi) inner.push(k + s);
      inner.sort((x, y) => x - y);
      return adaptive(this, [lo, ...inner, hi], deflection, turn);
    });
  }
}

class Polyline implements Curve {
  readonly period = 0;
  readonly domain: readonly [number, number];
  constructor(private readonly points: readonly XYZ[]) {
    this.domain = [0, Math.max(0, points.length - 1)];
  }
  at(t: number) {
    const n = this.points.length - 1,
      i = Math.max(0, Math.min(n - 1, Math.floor(t))),
      k = t - i,
      a = this.points[i],
      b = this.points[i + 1];
    return [...add(a, scale(sub(b, a), k)), ...sub(b, a)];
  }
  parameter(p: readonly number[]) {
    let best = Infinity,
      out = 0;
    for (let i = 0; i + 1 < this.points.length; i++) {
      const a = this.points[i],
        d = sub(this.points[i + 1], a),
        k = Math.max(0, Math.min(1, dot(sub(p, a), d) / (dot(d, d) || 1))),
        e = distance(add(a, scale(d, k)), p);
      if (e < best) {
        best = e;
        out = i + k;
      }
    }
    return out;
  }
  sample(a: number, b: number) {
    return ordered(a, b, (lo, hi) => {
      const inner: number[] = [];
      for (let i = Math.floor(lo) + 1; i < hi; i++) inner.push(i);
      return [lo, ...inner, hi];
    });
  }
}

/** A (rational) B-spline curve from STEP's simple or complex instance. */
function splineCurve(file: STEPFile, id: number): Curve {
  const entity = file.get(id),
    base = entity.parts ? entity.parts.get('B_SPLINE_CURVE') : entity.args.slice(1, 6),
    knotted = entity.parts ? entity.parts.get('B_SPLINE_CURVE_WITH_KNOTS') : entity.args.slice(6, 9),
    rational = entity.parts?.get('RATIONAL_B_SPLINE_CURVE');
  if (!base || !knotted) throw unsupported(file, id, 'B-spline curve (knots implied, not listed)');
  const degree = num(base[0]),
    controls = list(base[1]).map((v) => point(file, ref(v))),
    weights = rational ? list(rational[0]).map((w) => num(w, 1)) : undefined,
    knots = knotVector(
      list(knotted[1]).map((k) => num(k)),
      list(knotted[0]).map((m) => num(m)),
    );
  if (knots.length !== controls.length + degree + 1 || degree < 1)
    throw new TypeError(`Invalid STEP file: #${id} B-spline knots do not match its control points and degree`);
  const points = new Float64Array(controls.length * 4);
  controls.forEach((c, i) => {
    const w = weights?.[i] ?? 1;
    points.set([c[0] * w, c[1] * w, c[2] * w, w], i * 4);
  });
  // Closed when marked so, or when a clamped spline ends where it starts (exporters often leave the flag false).
  let size = 0;
  for (const c of controls) size = Math.max(size, Math.abs(c[0]), Math.abs(c[1]), Math.abs(c[2]));
  const closed =
    (base[3] instanceof Enum && base[3].name === 'T') ||
    (clamped(knots, degree) && distance(controls[0], controls[controls.length - 1]) <= 1e-9 * Math.max(size, 1e-30));
  return new Spline({ degree, points, knots }, closed);
}

/** The curve of entity `id` (cached per file by the caller). Throws a TypeError for a curve the kernel lacks. */
export function curveOf(file: STEPFile, id: number): Curve {
  const entity = file.get(id),
    type = entity.parts ? (entity.parts.has('B_SPLINE_CURVE') ? 'B_SPLINE_CURVE_WITH_KNOTS' : '') : entity.type,
    args: readonly STEPValue[] = entity.args;
  switch (type) {
    case 'LINE':
      return new Line(point(file, ref(args[1])), vector(file, ref(args[2])));
    case 'CIRCLE': {
      const r = num(args[2]);
      return new Ellipse(frame(file, ref(args[1])), r, r);
    }
    case 'ELLIPSE':
      return new Ellipse(frame(file, ref(args[1])), num(args[2]), num(args[3]));
    case 'B_SPLINE_CURVE_WITH_KNOTS':
      return splineCurve(file, id);
    case 'POLYLINE':
      return new Polyline(list(args[1]).map((v) => point(file, ref(v))));
    case 'SURFACE_CURVE':
    case 'SEAM_CURVE':
    case 'INTERSECTION_CURVE':
    case 'TRIMMED_CURVE': {
      const inner = ref(args[1]);
      if (inner === undefined) throw unsupported(file, id, 'curve');
      return curveOf(file, inner);
    }
    default:
      throw unsupported(file, id, 'curve');
  }
}

/** Evaluators for curves the modeler makes from parameters (no STEP entity behind them). */
export const makeCurve = {
  line: (origin: XYZ, direction: XYZ): Curve => new Line(origin, direction),
  /** A circle is an ellipse with equal semi-axes. */
  ellipse: (f: { origin: XYZ; x: XYZ; y: XYZ }, a: number, b: number): Curve => new Ellipse(f, a, b),
  spline: (s: SplineCurve, closed: boolean): Curve => new Spline(s, closed),
};
