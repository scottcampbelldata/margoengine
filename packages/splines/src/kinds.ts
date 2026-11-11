import { Spline } from './index.js';
import { checkVector, controls, cross, evaluate, segmentCount } from './polynomial.js';

/** Options for a cubic Bezier spline; closure requires matching first and last control points. */
export interface CubicSplineOptions {
  /** Periodic parameter and tangent handling. Default false. */
  closed?: boolean;
  /** Arc-length table divisions. Default 256. */
  divisions?: number;
}

/** A Bezier-backed Spline with analytic tangents, including closed paths. */
export class CubicSpline extends Spline {
  override readonly closed: boolean;
  constructor(points: readonly ArrayLike<number>[], options: CubicSplineOptions = {}) {
    super(points, { kind: 'bezier', divisions: options.divisions });
    if (options.closed !== undefined && typeof options.closed !== 'boolean')
      throw new RangeError('Invalid closure; pass a boolean closed option.');
    this.closed = options.closed ?? false;
    if (this.closed && [0, 1, 2].some((a) => this.points[a] !== this.points[this.points.length - 3 + a]))
      throw new RangeError('Closed cubic endpoints differ; repeat the first point at the end.');
  }
  override tangent(t: number, output: Float64Array | Float32Array = new Float64Array(3)): Float64Array | Float32Array {
    if (output.length !== 3) throw new RangeError('Invalid output; pass an array of length three.');
    const d = splineDerivative(this, t),
      length = Math.hypot(...d);
    for (let a = 0; a < 3; a++) output[a] = length ? d[a] / length : 0;
    return output;
  }
}

/** Nonuniform Catmull-Rom settings. */
export interface CatmullRomOptions extends CubicSplineOptions {
  /** Default centripetal (alpha=0.5); chordal uses alpha=1, uniform uses alpha=0. */
  parameterization?: 'centripetal' | 'chordal' | 'uniform';
}

/** Interpolate knots using centripetal (default), chordal or uniform Catmull-Rom, converted exactly to Bezier. */
export function catmullRomSpline(points: readonly ArrayLike<number>[], options: CatmullRomOptions = {}): CubicSpline {
  const kind = options.parameterization ?? 'centripetal';
  if (!['centripetal', 'chordal', 'uniform'].includes(kind) || points.length < 2 || points.length > 1_000_000)
    throw new RangeError('Invalid Catmull-Rom input; pass 2..1,000,000 points and a supported parameterization.');
  points.forEach(checkVector);
  const alpha = kind === 'uniform' ? 0 : kind === 'chordal' ? 1 : 0.5;
  const n = points.length,
    segments = options.closed ? n : n - 1,
    result: Float64Array[] = [];
  const point = (i: number): ArrayLike<number> => {
    if (options.closed) return points[(i + n) % n];
    if (i >= 0 && i < n) return points[i];
    const end = i < 0 ? 0 : n - 1,
      neighbor = i < 0 ? 1 : n - 2;
    return new Float64Array([0, 1, 2].map((a) => 2 * points[end][a] - points[neighbor][a]));
  };
  for (let i = 0; i < segments; i++) {
    const [p0, p1, p2, p3] = [i - 1, i, i + 1, i + 2].map(point);
    const span = (a: ArrayLike<number>, b: ArrayLike<number>): number =>
      alpha === 0 ? 1 : Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) ** alpha;
    const d = span(p1, p2),
      before = span(p0, p1) || d || 1,
      after = span(p2, p3) || d || 1;
    const b1 = new Float64Array(3),
      b2 = new Float64Array(3);
    for (let a = 0; a < 3; a++) {
      const m1 = d ? d * ((p1[a] - p0[a]) / before - (p2[a] - p0[a]) / (before + d) + (p2[a] - p1[a]) / d) : 0;
      const m2 = d ? d * ((p2[a] - p1[a]) / d - (p3[a] - p1[a]) / (d + after) + (p3[a] - p2[a]) / after) : 0;
      b1[a] = p1[a] + m1 / 3;
      b2[a] = p2[a] - m2 / 3;
    }
    if (!i) result.push(Float64Array.from(p1));
    result.push(b1, b2, Float64Array.from(p2));
  }
  return new CubicSpline(result, options);
}

/** Exact first, second or third derivative with respect to global t; joins use the right-hand piece. */
export function splineDerivative(
  spline: Spline,
  t: number,
  order: 1 | 2 | 3 = 1,
  output = new Float64Array(3),
): Float64Array {
  if (!Number.isFinite(t) || t < 0 || t > 1 || ![1, 2, 3].includes(order) || output.length !== 3)
    throw new RangeError('Invalid derivative; pass t in 0..1, order 1..3 and output length three.');
  const n = segmentCount(spline),
    scaled = (spline.closed && t === 1 ? 0 : t) * n;
  const i = Math.min(n - 1, Math.floor(scaled));
  evaluate(controls(spline, i), scaled - i, order, output);
  for (let a = 0; a < 3; a++) output[a] *= n ** order;
  return output;
}

/** Curvature |r' x r''| / |r'|^3; stationary points return NaN. */
export function splineCurvature(spline: Spline, t: number): number {
  const d = splineDerivative(spline, t),
    dd = splineDerivative(spline, t, 2),
    speed = Math.hypot(...d);
  return speed ? Math.hypot(...cross(d, dd)) / speed ** 3 : NaN;
}

/** Torsion det(r',r'',r''') / |r' x r''|^2; undefined osculating planes return NaN. */
export function splineTorsion(spline: Spline, t: number): number {
  const c = cross(splineDerivative(spline, t), splineDerivative(spline, t, 2)),
    ddd = splineDerivative(spline, t, 3);
  const norm2 = c[0] ** 2 + c[1] ** 2 + c[2] ** 2;
  return norm2 ? (c[0] * ddd[0] + c[1] * ddd[1] + c[2] * ddd[2]) / norm2 : NaN;
}
