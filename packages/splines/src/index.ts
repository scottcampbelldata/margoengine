export type CurveKind = 'catmull-rom' | 'bezier' | 'hermite';
export interface SplineOptions {kind?: CurveKind; closed?: boolean; tangents?: readonly ArrayLike<number>[]; divisions?: number}
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
  private readonly tangents?: Float64Array;
  private readonly output = new Float64Array(3);
  private readonly previous = new Float64Array(3);
  private readonly next = new Float64Array(3);
  private readonly count: number;
  constructor(points: readonly ArrayLike<number>[], {kind = 'catmull-rom', closed = false, tangents, divisions = 256}: SplineOptions = {}) {
    if (!['catmull-rom', 'bezier', 'hermite'].includes(kind) || typeof closed !== 'boolean' || !Number.isInteger(divisions) || divisions < 2 || divisions > 1_000_000 || points.length < 2 || points.length > 1_000_000) throw new RangeError('Invalid spline options');
    if (kind === 'bezier' && (points.length < 4 || (points.length - 1) % 3 || closed)) throw new RangeError('Bezier needs 3n+1 points and an open curve');
    if (kind === 'hermite' && (!tangents || tangents.length !== points.length)) throw new RangeError('Hermite needs a tangent for each point');
    this.kind = kind; this.closed = closed; this.count = points.length; this.points = new Float64Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {vector(points[i]); this.points.set(points[i], i * 3);}
    if (tangents) {this.tangents = new Float64Array(tangents.length * 3); for (let i = 0; i < tangents.length; i++) {vector(tangents[i]); this.tangents.set(tangents[i], i * 3);}}
    this.arcLengths = new Float64Array(divisions + 1); this.updateArcLengths();
  }
  private point(index: number, axis: number): number {
    if (this.closed) return this.points[((index % this.count + this.count) % this.count) * 3 + axis];
    if (index < 0) return 2 * this.points[axis] - this.points[3 + axis];
    if (index >= this.count) return 2 * this.points[(this.count - 1) * 3 + axis] - this.points[(this.count - 2) * 3 + axis];
    return this.points[index * 3 + axis];
  }
  at(t: number, output: Float64Array | Float32Array = this.output): typeof output {
    if (!Number.isFinite(t) || t < 0 || t > 1 || output.length !== 3) throw new RangeError('Curve parameter must be 0..1 and output length 3');
    const segments = this.kind === 'bezier' ? (this.count - 1) / 3 : this.closed ? this.count : this.count - 1;
    const scaled = t * segments, segment = Math.min(segments - 1, Math.floor(scaled)), u = scaled - segment, u2 = u * u, u3 = u2 * u;
    for (let a = 0; a < 3; a++) {
      if (this.kind === 'bezier') {
        const i = segment * 3, v = 1 - u;
        output[a] = v * v * v * this.point(i, a) + 3 * v * v * u * this.point(i + 1, a) + 3 * v * u2 * this.point(i + 2, a) + u3 * this.point(i + 3, a);
      } else {
        const p = this.point(segment, a), q = this.point(segment + 1, a);
        const m = this.kind === 'hermite' ? this.tangents![segment * 3 + a] : (q - this.point(segment - 1, a)) * 0.5;
        const n = this.kind === 'hermite' ? this.tangents![((segment + 1) % this.count) * 3 + a] : (this.point(segment + 2, a) - p) * 0.5;
        output[a] = (2 * u3 - 3 * u2 + 1) * p + (u3 - 2 * u2 + u) * m + (-2 * u3 + 3 * u2) * q + (u3 - u2) * n;
      }
    }
    return output;
  }
  tangent(t: number, output: Float64Array | Float32Array = this.output): typeof output {
    this.at(Math.max(0, t - 1e-5), this.previous); this.at(Math.min(1, t + 1e-5), this.next);
    if (output.length !== 3 || !Number.isFinite(t) || t < 0 || t > 1) throw new RangeError('Invalid tangent parameter');
    const x = this.next[0] - this.previous[0], y = this.next[1] - this.previous[1], z = this.next[2] - this.previous[2], length = Math.hypot(x, y, z) || 1;
    output[0] = x / length; output[1] = y / length; output[2] = z / length; return output;
  }
  get length(): number {return this.arcLengths[this.arcLengths.length - 1];}
  updateArcLengths(): void {
    const divisions = this.arcLengths.length - 1;
    this.at(0, this.previous); this.arcLengths[0] = 0;
    for (let i = 1; i <= divisions; i++) {
      this.at(i / divisions, this.next);
      this.arcLengths[i] = this.arcLengths[i - 1] + Math.hypot(this.next[0] - this.previous[0], this.next[1] - this.previous[1], this.next[2] - this.previous[2]);
      this.previous.set(this.next);
    }
  }
  atDistance(distance: number, output: Float64Array | Float32Array = this.output): typeof output {
    if (!Number.isFinite(distance) || distance < 0 || distance > this.length) throw new RangeError('Distance exceeds spline length');
    if (!this.length) return this.at(0, output);
    const lengths = this.arcLengths; let low = 0, high = lengths.length - 1;
    while (low + 1 < high) {const mid = (low + high) >>> 1; if (lengths[mid] < distance) low = mid; else high = mid;}
    const span = lengths[high] - lengths[low], fraction = span ? (distance - lengths[low]) / span : 0;
    return this.at((low + fraction) / (lengths.length - 1), output);
  }
}
