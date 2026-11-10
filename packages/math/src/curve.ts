/** Writable reusable sampled result, preserving normal array/typed-array iteration. */
export type CurveResult = number[] | Float32Array | Float64Array;

/** Interpolation modes for sampled data and editable tuning curves. */
export type CurveType = 'linear' | 'step' | 'smoothstep' | 'cubic';
/** Endpoint derivative policy for cubic interpolation. */
export type CurveEnding = 'natural' | 'flat' | 'wrap';
/** Cubic tangent controls. Natural endpoints have zero second derivative before optional derivative scaling. */
export interface CubicOptions {
  /** Default natural. */
  endingStart?: CurveEnding;
  /** Default natural. */
  endingEnd?: CurveEnding;
  /** Multiplier on derivatives; default 1 (Catmull-Rom interior derivatives). */
  tangentScale?: number;
}
/** Linear curve mode. */
export const CURVE_LINEAR = 'linear';
/** Smoothstep curve mode. */
export const CURVE_SMOOTHSTEP = 'smoothstep';
/** Cubic cardinal curve mode. */
export const CURVE_SPLINE = 'cubic';
/** Step curve mode. */
export const CURVE_STEP = 'step';
const modes: readonly CurveType[] = ['linear', 'step', 'smoothstep', 'cubic'];
const endings: readonly CurveEnding[] = ['natural', 'flat', 'wrap'];
const finite = (n: number): number => {
  if (!Number.isFinite(n))
    throw new RangeError('Curve values must be finite; supply finite times, samples and options');
  return n;
};
const modeOf = (mode: CurveType): CurveType => {
  if (!modes.includes(mode)) throw new TypeError('Unknown curve type; use linear, step, smoothstep or cubic');
  return mode;
};

/**
 * Immutable sampled data with random-access evaluation into a reusable resultBuffer. Channels are packed per key.
 * @throws RangeError for malformed samples or non-increasing/non-finite times; supply one sampleSize tuple per time.
 */
export class Interpolant {
  /** Copied strictly increasing times. */
  readonly parameterPositions: readonly number[];
  /** Copied sample-major values. */
  readonly sampleValues: readonly number[];
  /** Number of channels per sample. */
  readonly sampleSize: number;
  /** Caller-owned result or an allocated Float64Array, reused on every evaluation. */
  readonly resultBuffer: CurveResult;
  /** Validated interpolation mode. */
  readonly type: CurveType;
  private readonly options: Required<CubicOptions>;
  constructor(
    positions: ArrayLike<number>,
    values: ArrayLike<number>,
    sampleSize = 1,
    resultBuffer?: CurveResult,
    type: CurveType = 'linear',
    options: CubicOptions = {},
  ) {
    if (
      !Number.isInteger(sampleSize) ||
      sampleSize < 1 ||
      positions.length < 1 ||
      values.length !== positions.length * sampleSize
    )
      throw new RangeError(
        'Invalid interpolant dimensions; supply a positive integer sampleSize and one tuple per time',
      );
    const times = Array.from(positions, finite);
    if (times.some((t, i) => i > 0 && t <= times[i - 1]))
      throw new RangeError('Interpolant times must increase strictly; sort keys and remove duplicate times');
    const { endingStart = 'natural', endingEnd = 'natural', tangentScale = 1 } = options;
    if (!endings.includes(endingStart) || !endings.includes(endingEnd))
      throw new TypeError('Unknown cubic ending; use natural, flat or wrap');
    finite(tangentScale);
    if (
      resultBuffer &&
      ArrayBuffer.isView(resultBuffer) &&
      'length' in resultBuffer &&
      Number(resultBuffer.length) < sampleSize
    )
      throw new RangeError('Result buffer is too short; provide at least sampleSize writable slots');
    this.parameterPositions = Object.freeze(times);
    this.sampleValues = Object.freeze(Array.from(values, finite));
    this.sampleSize = sampleSize;
    this.resultBuffer = resultBuffer ?? new Float64Array(sampleSize);
    this.type = modeOf(type);
    this.options = { endingStart, endingEnd, tangentScale };
  }
  private slope(i: number, channel: number): number {
    const t = this.parameterPositions,
      v = this.sampleValues,
      n = t.length,
      size = this.sampleSize;
    if (n === 1) return 0;
    const secant = (a: number, b: number) => (v[b * size + channel] - v[a * size + channel]) / (t[b] - t[a]);
    if (i > 0 && i < n - 1) return secant(i - 1, i + 1);
    const start = i === 0,
      ending = start ? this.options.endingStart : this.options.endingEnd;
    if (ending === 'flat') return 0;
    if (ending === 'wrap' && n > 2) {
      const duration = t[1] - t[0] + (t[n - 1] - t[n - 2]);
      return (v[size + channel] - v[(n - 2) * size + channel]) / duration;
    }
    if (n === 2) return secant(0, 1);
    // Hermite's second derivative at the outside endpoint vanishes with (3*secant - innerDerivative)/2.
    return start ? (3 * secant(0, 1) - secant(0, 2)) / 2 : (3 * secant(n - 2, n - 1) - secant(n - 3, n - 1)) / 2;
  }
  /** Evaluates any finite time, clamping outside the sample range; returns the same reusable result buffer. */
  evaluate(time: number): CurveResult {
    finite(time);
    const times = this.parameterPositions,
      values = this.sampleValues,
      size = this.sampleSize,
      n = times.length;
    let a = 0,
      b = n - 1;
    while (b - a > 1) {
      const mid = (a + b) >>> 1;
      if (time < times[mid]) b = mid;
      else a = mid;
    }
    if (time <= times[0]) a = b = 0;
    else if (time >= times[n - 1]) a = b = n - 1;
    const span = times[b] - times[a],
      u = span ? (time - times[a]) / span : 0;
    for (let c = 0; c < size; c++) {
      const left = values[a * size + c],
        right = values[b * size + c];
      let value = left;
      if (a !== b && this.type !== 'step') {
        if (this.type === 'cubic') {
          const u2 = u * u,
            u3 = u2 * u,
            scale = span * this.options.tangentScale;
          value =
            (2 * u3 - 3 * u2 + 1) * left +
            (u3 - 2 * u2 + u) * this.slope(a, c) * scale +
            (-2 * u3 + 3 * u2) * right +
            (u3 - u2) * this.slope(b, c) * scale;
        } else {
          const weight = this.type === 'smoothstep' ? u * u * (3 - 2 * u) : u;
          value = left + (right - left) * weight;
        }
      }
      this.resultBuffer[c] = value;
    }
    return this.resultBuffer;
  }
}

/** Linear interpolation with endpoint clamping. */
export class LinearInterpolant extends Interpolant {
  constructor(times: ArrayLike<number>, values: ArrayLike<number>, sampleSize = 1, result?: CurveResult) {
    super(times, values, sampleSize, result, 'linear');
  }
}
/** Left-held step interpolation; exact key times return that key. */
export class StepInterpolant extends Interpolant {
  constructor(times: ArrayLike<number>, values: ArrayLike<number>, sampleSize = 1, result?: CurveResult) {
    super(times, values, sampleSize, result, 'step');
  }
}
/** Alias for step interpolation using the familiar sampled-data name. */
export class DiscreteInterpolant extends StepInterpolant {}
/** Smoothstep interpolation with zero endpoint slopes on each interval. */
export class SmoothstepInterpolant extends Interpolant {
  constructor(times: ArrayLike<number>, values: ArrayLike<number>, sampleSize = 1, result?: CurveResult) {
    super(times, values, sampleSize, result, 'smoothstep');
  }
}
/** Nonuniform cubic Hermite interpolation with selectable endpoint derivatives. */
export class CubicInterpolant extends Interpolant {
  constructor(
    times: ArrayLike<number>,
    values: ArrayLike<number>,
    sampleSize = 1,
    result?: CurveResult,
    options: CubicOptions = {},
  ) {
    super(times, values, sampleSize, result, 'cubic', options);
  }
}

/** Time/value pair. Times use caller-selected units. */
export type CurveKey = readonly [time: number, value: number];
/** Editable curve input: pairs or a flat [time,value,...] sequence. */
export type CurveKeys = readonly CurveKey[] | readonly number[];
/**
 * Editable scalar curve. Defaults to smoothstep, with clamped endpoints and sorted, unique keys; adding a duplicate replaces it.
 * @throws RangeError for non-finite keys or malformed flat pairs; supply finite time/value pairs.
 */
export class Curve {
  private points: [number, number][] = [];
  private cached?: Interpolant;
  private interpolation: CurveType;
  private tightness = 0.5;
  constructor(keys: CurveKeys = [], type: CurveType = 'smoothstep') {
    this.interpolation = modeOf(type);
    if (typeof keys[0] === 'number') {
      if (keys.length % 2)
        throw new RangeError('Flat curve keys need time/value pairs; supply an even number of values');
      const flat = keys as readonly number[];
      for (let i = 0; i < flat.length; i += 2) this.add(flat[i], flat[i + 1]);
    } else
      for (const key of keys as readonly CurveKey[]) {
        if (key.length !== 2) throw new RangeError('Curve keys need exactly two entries; supply [time,value] pairs');
        this.add(key[0], key[1]);
      }
  }
  /** Independent ordered pairs; mutate the curve with add/remove instead. */
  get keys(): readonly CurveKey[] {
    return this.points.map((p) => [...p] as [number, number]);
  }
  /** Number of keys. */
  get length(): number {
    return this.points.length;
  }
  /** Interpolation mode; default smoothstep. */
  get type(): CurveType {
    return this.interpolation;
  }
  set type(type: CurveType) {
    this.interpolation = modeOf(type);
    this.cached = undefined;
  }
  /** Cubic derivative scale / 2, default 0.5. Zero flattens derivatives; finite nonnegative values are accepted. */
  get tension(): number {
    return this.tightness;
  }
  set tension(value: number) {
    finite(value);
    if (value < 0) throw new RangeError('Curve tension must be nonnegative; use 0.5 for Catmull-Rom derivatives');
    this.tightness = value;
    this.cached = undefined;
  }
  /** Adds a key in order, replacing the value at an existing time; returns an independent pair. */
  add(time: number, value: number): CurveKey {
    finite(time);
    finite(value);
    const existing = this.points.findIndex((p) => p[0] >= time);
    if (existing < 0) this.points.push([time, value]);
    else if (this.points[existing][0] === time) this.points[existing] = [time, value];
    else this.points.splice(existing, 0, [time, value]);
    this.cached = undefined;
    return [time, value];
  }
  /** Pair at index, copied; undefined for an absent index. */
  get(index: number): CurveKey | undefined {
    const key = this.points[index];
    return key ? [...key] : undefined;
  }
  /** Removes a key by index, returning its independent pair or undefined. */
  remove(index: number): CurveKey | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    this.cached = undefined;
    return this.points.splice(index, 1)[0];
  }
  /** Removes every key and invalidates the sampled cache. */
  clear(): this {
    this.points = [];
    this.cached = undefined;
    return this;
  }
  /** Keys are maintained in sorted order; returns this for familiar editing flows. */
  sort(): this {
    return this;
  }
  /** Nearest key in time; ties choose the later key. */
  closest(time: number): CurveKey | null {
    finite(time);
    let best: CurveKey | undefined;
    for (const key of this.points) if (!best || Math.abs(key[0] - time) <= Math.abs(best[0] - time)) best = key;
    return best ? [...best] : null;
  }
  /** Scalar value at a finite time; empty curves return 0, single-key curves are constant. */
  value(time: number): number {
    finite(time);
    if (!this.length) return 0;
    this.cached ??= new Interpolant(
      this.points.map((p) => p[0]),
      this.points.map((p) => p[1]),
      1,
      undefined,
      this.type,
      { tangentScale: 2 * this.tension },
    );
    return this.cached.evaluate(time)[0];
  }
  /** Scalar alias of value(). */
  evaluate(time: number): number {
    return this.value(time);
  }
  /** Independent keys and interpolation controls. */
  clone(): Curve {
    const copy = new Curve(this.keys, this.type);
    copy.tension = this.tension;
    return copy;
  }
  /** Samples precision evenly spaced values including start/end (defaults 0..1) into a new Float32Array. */
  quantize(precision: number, start = 0, end = 1): Float32Array {
    if (!Number.isInteger(precision) || precision < 2)
      throw new RangeError('Curve precision must be an integer >= 2; choose at least two samples');
    finite(start);
    finite(end);
    const out = new Float32Array(precision);
    for (let i = 0; i < precision; i++) out[i] = this.value(start + ((end - start) * i) / (precision - 1));
    return out;
  }
  /** Samples 0..1 and clamps values to min/max. */
  quantizeClamped(precision: number, min: number, max: number): Float32Array {
    finite(min);
    finite(max);
    if (min > max) throw new RangeError('Curve clamp minimum exceeds maximum; put limits in increasing order');
    return this.quantize(precision).map((v) => Math.max(min, Math.min(max, v)));
  }
}

/** Independent scalar curves evaluated as a tuple, with sample-major quantized output. */
export class CurveSet {
  private list: Curve[];
  private interpolation: CurveType = 'smoothstep';
  constructor(count?: number);
  constructor(curves: readonly (Curve | CurveKeys)[]);
  constructor(first: CurveKeys, ...rest: CurveKeys[]);
  constructor(input: number | readonly (Curve | CurveKeys)[] | CurveKeys = 1, ...rest: CurveKeys[]) {
    if (typeof input === 'number') {
      if (!Number.isSafeInteger(input) || input < 0)
        throw new RangeError('CurveSet count must be a nonnegative integer; supply a valid channel count');
      this.list = Array.from({ length: input }, () => new Curve());
    } else {
      const channels = (rest.length || typeof input[0] === 'number' ? [input, ...rest] : input) as readonly (
        | Curve
        | CurveKeys
      )[];
      this.list = channels.map((c) => (c instanceof Curve ? c.clone() : new Curve(c)));
      this.interpolation = this.list[0]?.type ?? 'smoothstep';
    }
  }
  /** Snapshot of the channel list; contained curves remain editable. */
  get curves(): readonly Curve[] {
    return [...this.list];
  }
  /** Appends an independent curve adopting this set's current interpolation mode. */
  add(keys: Curve | CurveKeys = []): Curve {
    const curve = keys instanceof Curve ? keys.clone() : new Curve(keys);
    curve.type = this.type;
    this.list.push(curve);
    return curve;
  }
  /** Removes one channel by index; returns undefined if absent. */
  remove(index: number): Curve | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    return this.list.splice(index, 1)[0];
  }
  /** Removes every channel. */
  clear(): this {
    this.list = [];
    return this;
  }
  /** Clears every channel's keys, retaining channel count and controls. */
  clearKeys(): this {
    for (const curve of this.list) curve.clear();
    return this;
  }

  /** Number of scalar channels. */
  get length(): number {
    return this.list.length;
  }
  /** Mutable curve at index, or undefined. */
  get(index: number): Curve | undefined {
    return this.list[index];
  }
  /** Sets the mode of every channel. */
  set type(type: CurveType) {
    this.interpolation = modeOf(type);
    for (const curve of this.list) curve.type = type;
  }
  /** The mode last set on the whole set (at construction, the first channel's); a channel changed alone through `get(i)` is not reflected. */
  get type(): CurveType {
    return this.interpolation;
  }
  /** Writes each channel into result (default a new number array). */
  value(time: number, result: CurveResult = []): CurveResult {
    finite(time);
    if (ArrayBuffer.isView(result) && result.length < this.length)
      throw new RangeError('CurveSet result buffer is too short; supply one slot per channel');
    for (let i = 0; i < this.length; i++) result[i] = this.list[i].value(time);
    return result;
  }
  /** Independent channels and controls. */
  clone(): CurveSet {
    const copy = new CurveSet(this.list);
    copy.interpolation = this.interpolation;
    return copy;
  }
  /** Samples 0..1 into packed sample-major channel tuples. */
  quantize(precision: number): Float32Array {
    if (!Number.isInteger(precision) || precision < 2)
      throw new RangeError('CurveSet precision must be an integer >= 2; choose at least two samples');
    const out = new Float32Array(precision * this.length),
      tuple: number[] = [];
    for (let i = 0; i < precision; i++) {
      this.value(i / (precision - 1), tuple);
      out.set(tuple, i * this.length);
    }
    return out;
  }
  /** Quantized channel tuples clamped to min/max. */
  quantizeClamped(precision: number, min: number, max: number): Float32Array {
    finite(min);
    finite(max);
    if (min > max) throw new RangeError('CurveSet limits must increase; put minimum before maximum');
    return this.quantize(precision).map((v) => Math.max(min, Math.min(max, v)));
  }
}
