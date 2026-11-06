import { Spline, type SplineOptions } from './index.js';

/**
 * How a knot's two handles are set: 'auto' makes a smooth pass through the knot from its neighbors, 'linear' points
 * both handles at the neighbors (a segment between two linear knots is a straight line), and 'broken' keeps
 * `tangentIn` and `tangentOut` exactly as stored, so a corner can point any way.
 */
export type TangentMode = 'auto' | 'linear' | 'broken';
type KnotVec = [number, number, number];
/** One editable control point of a {@link KnotPath}. */
export interface Knot {
  position: KnotVec;
  mode: TangentMode;
  /** Handle offset from `position` toward the previous knot; read for 'broken' knots only. */
  tangentIn: KnotVec;
  /** Handle offset from `position` toward the next knot; read for 'broken' knots only. */
  tangentOut: KnotVec;
  /** Numbers attached to the knot (width, colour channel, speed...), blended linearly along each segment. */
  data: number[];
}
/** A knot as passed in; everything but `position` is optional. */
export interface KnotInput {
  position: ArrayLike<number>;
  mode?: TangentMode;
  tangentIn?: ArrayLike<number>;
  tangentOut?: ArrayLike<number>;
  data?: ArrayLike<number>;
}
/** Options for `new KnotPath(...)`. */
export interface KnotPathOptions {
  /** Join the last knot back to the first (needs 3 or more knots). Default false. */
  closed?: boolean;
}

const MODES: readonly string[] = ['auto', 'linear', 'broken'];
const vec = (value: ArrayLike<number> | undefined, what: string): KnotVec => {
  if (
    !value ||
    value.length !== 3 ||
    !(Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2]))
  )
    throw new TypeError(`${what} must be a finite 3D vector`);
  return [value[0], value[1], value[2]];
};
const lerp3 = (a: KnotVec, b: KnotVec, u: number): KnotVec => [
  a[0] + (b[0] - a[0]) * u,
  a[1] + (b[1] - a[1]) * u,
  a[2] + (b[2] - a[2]) * u,
];
const add3 = (a: KnotVec, b: KnotVec): KnotVec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: KnotVec, b: KnotVec): KnotVec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * An editable chain of knots that builds a cubic Bezier {@link Spline}: insert, remove and split knots, set how each
 * knot's tangents behave, and attach numbers to each knot that you can read back along the curve. A closed path
 * builds an open Bezier whose last point is its first, so `Spline.closed` stays false for it.
 */
export class KnotPath {
  readonly knots: Knot[] = [];
  readonly closed: boolean;
  constructor(knots: readonly KnotInput[], { closed = false }: KnotPathOptions = {}) {
    if (typeof closed !== 'boolean') throw new TypeError('closed must be a boolean');
    this.closed = closed;
    const min = closed ? 3 : 2;
    if (knots.length < min || knots.length > 1_000_000)
      throw new RangeError(`A ${closed ? 'closed' : 'open'} path needs ${min} to 1,000,000 knots`);
    for (const input of knots) this.knots.push(this.make(input));
    this.checkData();
    this.freezeBroken(0, this.knots.length);
  }
  private make(input: KnotInput): Knot {
    const mode = input.mode ?? 'auto';
    if (!MODES.includes(mode)) throw new RangeError("mode must be 'auto', 'linear' or 'broken'");
    const data = input.data ? Array.from(input.data) : [];
    for (const v of data) if (!Number.isFinite(v)) throw new RangeError('Knot data must be finite');
    return {
      position: vec(input.position, 'position'),
      mode,
      tangentIn: input.tangentIn ? vec(input.tangentIn, 'tangentIn') : [NaN, 0, 0],
      tangentOut: input.tangentOut ? vec(input.tangentOut, 'tangentOut') : [NaN, 0, 0],
      data,
    };
  }
  private checkData(): void {
    const width = this.knots[0].data.length;
    for (const knot of this.knots)
      if (knot.data.length !== width) throw new RangeError('Every knot needs the same number of data values');
  }
  /** A 'broken' knot given without a handle takes the handle 'auto' would make, once all knots are known. */
  private freezeBroken(from: number, to: number): void {
    for (let i = from; i < to; i++) {
      const knot = this.knots[i];
      if (knot.mode !== 'broken') continue;
      const h = this.handles(i, true);
      if (Number.isNaN(knot.tangentIn[0])) knot.tangentIn = h.tangentIn;
      if (Number.isNaN(knot.tangentOut[0])) knot.tangentOut = h.tangentOut;
    }
  }
  get count(): number {
    return this.knots.length;
  }
  /** Number of segments between knots (one more than `count - 1` when closed). */
  get segments(): number {
    return this.closed ? this.knots.length : this.knots.length - 1;
  }
  private neighbor(i: number, step: number): Knot | undefined {
    const n = this.knots.length,
      j = i + step;
    return this.closed ? this.knots[(j + n) % n] : this.knots[j];
  }
  /** The handle offsets a knot builds with, whatever its mode (for 'broken' knots, as stored). */
  handles(index: number, ignoreStored = false): { tangentIn: KnotVec; tangentOut: KnotVec } {
    const knot = this.knots[index];
    if (!knot) throw new RangeError('No knot at that index; pass 0 to count - 1');
    if (knot.mode === 'broken' && !ignoreStored)
      return { tangentIn: [...knot.tangentIn], tangentOut: [...knot.tangentOut] };
    const p = knot.position,
      prev = this.neighbor(index, -1)?.position,
      next = this.neighbor(index, 1)?.position;
    if (knot.mode === 'linear' || !prev || !next) {
      // Linear knots, and the free end of an open path, point straight at the neighbor they have.
      const toward = (q: KnotVec | undefined, other: KnotVec | undefined): KnotVec =>
        q
          ? [(q[0] - p[0]) / 3, (q[1] - p[1]) / 3, (q[2] - p[2]) / 3]
          : other
            ? [-(other[0] - p[0]) / 3, -(other[1] - p[1]) / 3, -(other[2] - p[2]) / 3]
            : [0, 0, 0];
      return { tangentIn: toward(prev, next), tangentOut: toward(next, prev) };
    }
    // Smooth: handle length is a sixth of the neighbors' span, the Bezier form of a Catmull-Rom tangent.
    const out: KnotVec = [(next[0] - prev[0]) / 6, (next[1] - prev[1]) / 6, (next[2] - prev[2]) / 6];
    return { tangentIn: [-out[0], -out[1], -out[2]], tangentOut: out };
  }
  /** Change a knot's mode; 'broken' freezes the handles it currently builds with unless new ones are given. */
  setMode(
    index: number,
    mode: TangentMode,
    handles: { tangentIn?: ArrayLike<number>; tangentOut?: ArrayLike<number> } = {},
  ): void {
    const knot = this.knots[index];
    if (!knot) throw new RangeError('No knot at that index; pass 0 to count - 1');
    if (!MODES.includes(mode)) throw new RangeError("mode must be 'auto', 'linear' or 'broken'");
    const current = this.handles(index);
    knot.mode = mode;
    if (mode === 'broken') {
      knot.tangentIn = handles.tangentIn ? vec(handles.tangentIn, 'tangentIn') : current.tangentIn;
      knot.tangentOut = handles.tangentOut ? vec(handles.tangentOut, 'tangentOut') : current.tangentOut;
    }
  }
  /** Insert a knot before `index` (0..count; `count` appends). Returns the index it took. */
  insert(index: number, input: KnotInput): number {
    if (!Number.isInteger(index) || index < 0 || index > this.knots.length)
      throw new RangeError('index must be from 0 to count');
    if (this.knots.length >= 1_000_000) throw new RangeError('A path holds at most 1,000,000 knots');
    const knot = this.make(input);
    if (this.knots.length && knot.data.length !== this.knots[0].data.length)
      throw new RangeError('Every knot needs the same number of data values');
    this.knots.splice(index, 0, knot);
    this.freezeBroken(index, index + 1);
    return index;
  }
  /**
   * Split segment `segment` at local parameter `u` (0..1, in the Bezier parameter of that segment) and insert a knot
   * on the curve there; its data is blended from the two ends. With `preserveShape` (default) the curve does not
   * move: the new knot and its two neighbors become 'broken' with the handles de Casteljau gives them. Without it the
   * new knot is 'auto' and neighbors keep their modes, so the curve reshapes around it.
   */
  insertAt(segment: number, u: number, preserveShape = true): number {
    if (!Number.isInteger(segment) || segment < 0 || segment >= this.segments)
      throw new RangeError('No segment at that index; pass 0 to segments - 1');
    if (!Number.isFinite(u) || u <= 0 || u >= 1) throw new RangeError('u must be between 0 and 1, exclusive');
    const n = this.knots.length,
      a = this.knots[segment],
      bIndex = (segment + 1) % n,
      b = this.knots[bIndex],
      ha = this.handles(segment),
      hb = this.handles(bIndex),
      p0 = a.position,
      p3 = b.position,
      p1 = add3(p0, ha.tangentOut),
      p2 = add3(p3, hb.tangentIn),
      q0 = lerp3(p0, p1, u),
      q1 = lerp3(p1, p2, u),
      q2 = lerp3(p2, p3, u),
      r0 = lerp3(q0, q1, u),
      r1 = lerp3(q1, q2, u),
      s = lerp3(r0, r1, u),
      data = a.data.map((v, i) => v + (b.data[i] - v) * u);
    if (preserveShape) {
      this.setMode(segment, 'broken');
      this.setMode(bIndex, 'broken');
      a.tangentOut = sub3(q0, p0);
      b.tangentIn = sub3(q2, p3);
    }
    const knot: Knot = {
      position: s,
      mode: preserveShape ? 'broken' : 'auto',
      tangentIn: sub3(r0, s),
      tangentOut: sub3(r1, s),
      data,
    };
    this.knots.splice(segment + 1, 0, knot);
    return segment + 1;
  }
  /** Remove a knot. Its neighbors keep their modes; 'broken' handles stay as they are. */
  remove(index: number): void {
    const min = this.closed ? 3 : 2;
    if (!Number.isInteger(index) || index < 0 || index >= this.knots.length)
      throw new RangeError('No knot at that index; pass 0 to count - 1');
    if (this.knots.length <= min)
      throw new RangeError(`A ${this.closed ? 'closed' : 'open'} path needs at least ${min} knots`);
    this.knots.splice(index, 1);
  }
  /**
   * Cut the path at a knot. An open path gives two open paths that share that knot (it needs an interior knot);
   * a closed path gives one open path that starts and ends there. The shape of every segment is unchanged.
   */
  split(index: number): KnotPath[] {
    const n = this.knots.length;
    if (!Number.isInteger(index) || index < 0 || index >= n)
      throw new RangeError('No knot at that index; pass 0 to count - 1');
    // Freeze every knot so each piece keeps the handles it had inside the whole path.
    const snapshot = (k: number): KnotInput => {
      const knot = this.knots[k];
      return { position: knot.position, mode: 'broken', ...this.handles(k), data: knot.data };
    };
    const open = (ids: number[]): KnotPath => new KnotPath(ids.map(snapshot), {});
    if (this.closed) {
      const ids: number[] = [];
      for (let i = 0; i <= n; i++) ids.push((index + i) % n);
      return [open(ids)];
    }
    if (index === 0 || index === n - 1)
      throw new RangeError('An open path can only be split at an interior knot; pass 1 to count - 2');
    const first: number[] = [],
      second: number[] = [];
    for (let i = 0; i <= index; i++) first.push(i);
    for (let i = index; i < n; i++) second.push(i);
    return [open(first), open(second)];
  }
  /** Blended data at curve parameter `t` (0..1) of the spline this path builds. */
  dataAt(t: number, output: number[] = []): number[] {
    if (!Number.isFinite(t) || t < 0 || t > 1) throw new RangeError('Curve parameter must be 0..1');
    const segments = this.segments,
      scaled = t * segments,
      k = Math.min(segments - 1, Math.floor(scaled)),
      w = scaled - k,
      a = this.knots[k].data,
      b = this.knots[(k + 1) % this.knots.length].data;
    output.length = a.length;
    for (let i = 0; i < a.length; i++) output[i] = a[i] + (b[i] - a[i]) * w;
    return output;
  }
  /** Build the Bezier spline (3 control points per segment, plus the last knot). */
  toSpline(options: Omit<SplineOptions, 'kind' | 'closed' | 'tangents'> = {}): Spline {
    const n = this.knots.length,
      points: KnotVec[] = [];
    for (let k = 0; k < this.segments; k++) {
      const a = this.knots[k],
        b = this.knots[(k + 1) % n];
      points.push(
        a.position,
        add3(a.position, this.handles(k).tangentOut),
        add3(b.position, this.handles((k + 1) % n).tangentIn),
      );
    }
    points.push(this.knots[this.closed ? 0 : n - 1].position);
    return new Spline(points, { ...options, kind: 'bezier' });
  }
}
