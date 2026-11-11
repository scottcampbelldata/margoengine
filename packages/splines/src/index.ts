/**
 * Segment basis: 'catmull-rom' passes through every point, 'bezier' uses 3n+1 control points, 'hermite' takes a
 * tangent per point, 'kochanek-bartels' passes through every point with tension, continuity and bias controls, and
 * 'bspline' is the uniform cubic B-spline (smooth, pulled toward but not through interior points; open curves are
 * clamped to start and end at the first and last point).
 */
export type CurveKind = 'catmull-rom' | 'bezier' | 'hermite' | 'kochanek-bartels' | 'bspline';
const KINDS: readonly string[] = ['catmull-rom', 'bezier', 'hermite', 'kochanek-bartels', 'bspline'];
/** Options for `new Spline(...)`; invalid combinations throw a RangeError. */
export interface SplineOptions {
  /** Default 'catmull-rom'. */
  kind?: CurveKind;
  /** Join the last point back to the first; not allowed for 'bezier'. Default false. */
  closed?: boolean;
  /** One finite 3D tangent per point; required for 'hermite'. */
  tangents?: readonly ArrayLike<number>[];
  /** 'kochanek-bartels' only: -1 (looser) to 1 (tighter) at each point. Default 0. */
  tension?: number;
  /** 'kochanek-bartels' only: -1 (rounded) to 1 (sharp corners) at each point. Default 0. */
  continuity?: number;
  /** 'kochanek-bartels' only: -1 (undershoot) to 1 (overshoot) at each point. Default 0. */
  bias?: number;
  /** Samples of the arc-length lookup, an integer 2..1,000,000. Default 256. */
  divisions?: number;
}
const vector = (value: ArrayLike<number>): void => {
  if (value.length !== 3) throw new TypeError('Expected 3D point');
  for (let i = 0; i < 3; i++) if (!Number.isFinite(value[i])) throw new RangeError('Curve points must be finite');
};

/** Piecewise cubic curves with a cached arc-length lookup and caller-owned outputs. */
export class Spline {
  readonly points: Float64Array;
  readonly arcLengths: Float64Array;
  readonly kind: CurveKind;
  readonly closed: boolean;
  /** Kochanek-Bartels settings, as given (0 when unused). */
  readonly tension: number;
  readonly continuity: number;
  readonly bias: number;
  private readonly tangents?: Float64Array;
  private readonly output = new Float64Array(3);
  private readonly previous = new Float64Array(3);
  private readonly next = new Float64Array(3);
  private readonly count: number;
  constructor(
    points: readonly ArrayLike<number>[],
    {
      kind = 'catmull-rom',
      closed = false,
      tangents,
      divisions = 256,
      tension = 0,
      continuity = 0,
      bias = 0,
    }: SplineOptions = {},
  ) {
    if (
      !KINDS.includes(kind) ||
      ![tension, continuity, bias].every((v) => Number.isFinite(v) && v >= -1 && v <= 1) ||
      typeof closed !== 'boolean' ||
      !Number.isInteger(divisions) ||
      divisions < 2 ||
      divisions > 1_000_000 ||
      points.length < 2 ||
      points.length > 1_000_000
    )
      throw new RangeError(
        'Invalid spline options; give 2 to 1,000,000 finite points, 2 to 1,000,000 divisions and a boolean closed.',
      );
    if (kind === 'bezier' && (points.length < 4 || (points.length - 1) % 3 || closed))
      throw new RangeError('Bezier needs 3n+1 points and an open curve');
    if (kind === 'hermite' && (!tangents || tangents.length !== points.length))
      throw new RangeError('Hermite needs a tangent for each point');
    this.kind = kind;
    this.closed = closed;
    this.tension = tension;
    this.continuity = continuity;
    this.bias = bias;
    this.count = points.length;
    this.points = new Float64Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      vector(points[i]);
      this.points.set(points[i], i * 3);
    }
    if (tangents) {
      this.tangents = new Float64Array(tangents.length * 3);
      for (let i = 0; i < tangents.length; i++) {
        vector(tangents[i]);
        this.tangents.set(tangents[i], i * 3);
      }
    }
    this.arcLengths = new Float64Array(divisions + 1);
    this.updateArcLengths();
  }
  at(t: number, output: Float64Array | Float32Array = this.output): Float64Array | Float32Array {
    if (!Number.isFinite(t) || t < 0 || t > 1 || output.length !== 3)
      throw new RangeError('Curve parameter must be 0..1 and output length 3');
    const points = this.points,
      count = this.count,
      kind = this.kind,
      closed = this.closed;
    const segments = kind === 'bezier' ? (count - 1) / 3 : closed ? count : count - 1;
    const scaled = (closed && t === 1 ? 0 : t) * segments,
      segment = Math.min(segments - 1, Math.floor(scaled)),
      u = scaled - segment,
      u2 = u * u,
      u3 = u2 * u;
    // Control-point offsets and basis weights are resolved once per call; each axis still reads the points in turn.
    if (kind === 'bezier') {
      const i = segment * 9,
        v = 1 - u,
        b0 = v * v * v,
        b1 = 3 * v * v * u,
        b2 = 3 * v * u2;
      for (let a = 0; a < 3; a++)
        output[a] = b0 * points[i + a] + b1 * points[i + 3 + a] + b2 * points[i + 6 + a] + u3 * points[i + 9 + a];
      return output;
    }
    const h0 = 2 * u3 - 3 * u2 + 1,
      h1 = u3 - 2 * u2 + u,
      h2 = -2 * u3 + 3 * u2,
      h3 = u3 - u2;
    // Open curves always have `segment` and `segment + 1` in range; closed curves wrap the far end.
    const i = segment * 3,
      j = closed ? ((segment + 1) % count) * 3 : i + 3;
    if (kind === 'hermite') {
      const tangents = this.tangents!;
      for (let a = 0; a < 3; a++)
        output[a] =
          h0 * points[i + a] +
          h1 * tangents[i + a] +
          h2 * points[j + a] +
          h3 * tangents[((segment + 1) % count) * 3 + a];
      return output;
    }
    // Neighbors: wrapped when closed, otherwise mirrored through the end point.
    const before = closed ? ((segment + count - 1) % count) * 3 : segment > 0 ? i - 3 : -1,
      after = closed ? ((segment + 2) % count) * 3 : segment + 2 < count ? j + 3 : -1,
      last = (count - 1) * 3;
    if (kind === 'bspline') {
      const v = 1 - u,
        w0 = (v * v * v) / 6,
        w1 = (3 * u3 - 6 * u2 + 4) / 6,
        w2 = (-3 * u3 + 3 * u2 + 3 * u + 1) / 6,
        w3 = u3 / 6;
      for (let a = 0; a < 3; a++) {
        const o = before < 0 ? 2 * points[a] - points[3 + a] : points[before + a];
        const x = after < 0 ? 2 * points[last + a] - points[last - 3 + a] : points[after + a];
        output[a] = w0 * o + w1 * points[i + a] + w2 * points[j + a] + w3 * x;
      }
      return output;
    }
    // Catmull-Rom is Kochanek-Bartels with all three controls at zero (both weights 0.5).
    const kb = kind === 'kochanek-bartels',
      k = 1 - this.tension,
      wa = kb ? (k * (1 + this.bias) * (1 + this.continuity)) / 2 : 0.5,
      wb = kb ? (k * (1 - this.bias) * (1 - this.continuity)) / 2 : 0.5,
      wc = kb ? (k * (1 + this.bias) * (1 - this.continuity)) / 2 : 0.5,
      wd = kb ? (k * (1 - this.bias) * (1 + this.continuity)) / 2 : 0.5;
    for (let a = 0; a < 3; a++) {
      const p = points[i + a],
        q = points[j + a];
      const o = before < 0 ? 2 * points[a] - points[3 + a] : points[before + a];
      const x = after < 0 ? 2 * points[last + a] - points[last - 3 + a] : points[after + a];
      const m = kb ? wa * (p - o) + wb * (q - p) : (q - o) * 0.5;
      const n = kb ? wc * (q - p) + wd * (x - q) : (x - p) * 0.5;
      output[a] = h0 * p + h1 * m + h2 * q + h3 * n;
    }
    return output;
  }
  tangent(t: number, output: Float64Array | Float32Array = this.output): Float64Array | Float32Array {
    if (output.length !== 3 || !Number.isFinite(t) || t < 0 || t > 1)
      throw new RangeError('Invalid tangent parameter; pass t from 0 to 1 and an output array of 3 elements.');
    const at = this.closed && t === 1 ? 0 : t,
      before = at - 1e-5,
      after = at + 1e-5;
    this.at(this.closed && before < 0 ? before + 1 : Math.max(0, before), this.previous);
    this.at(this.closed && after > 1 ? after - 1 : Math.min(1, after), this.next);
    const x = this.next[0] - this.previous[0],
      y = this.next[1] - this.previous[1],
      z = this.next[2] - this.previous[2],
      length = Math.hypot(x, y, z) || 1;
    output[0] = x / length;
    output[1] = y / length;
    output[2] = z / length;
    return output;
  }
  get length(): number {
    return this.arcLengths[this.arcLengths.length - 1];
  }
  updateArcLengths(): void {
    const divisions = this.arcLengths.length - 1;
    this.at(0, this.previous);
    this.arcLengths[0] = 0;
    for (let i = 1; i <= divisions; i++) {
      this.at(i / divisions, this.next);
      this.arcLengths[i] =
        this.arcLengths[i - 1] +
        Math.hypot(this.next[0] - this.previous[0], this.next[1] - this.previous[1], this.next[2] - this.previous[2]);
      this.previous.set(this.next);
    }
  }
  atDistance(distance: number, output: Float64Array | Float32Array = this.output): Float64Array | Float32Array {
    if (!Number.isFinite(distance) || distance < 0 || distance > this.length)
      throw new RangeError('Distance must be from 0 to the spline length; pass a finite distance within the length.');
    if (!this.length) return this.at(0, output);
    const lengths = this.arcLengths;
    let low = 0,
      high = lengths.length - 1;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (lengths[mid] < distance) low = mid;
      else high = mid;
    }
    const span = lengths[high] - lengths[low],
      fraction = span ? (distance - lengths[low]) / span : 0;
    return this.at((low + fraction) / (lengths.length - 1), output);
  }
}
