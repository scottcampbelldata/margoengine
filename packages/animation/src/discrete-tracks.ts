import { rangeError } from '../../shared/errors.js';
/** Step interpolation identifier, shared with familiar keyframe APIs. */
export const InterpolateDiscrete = 2300;
/** Categorical values are never numerically interpolated. */
export type DiscreteValue = boolean | string;
/** Optional property path or explicit synchronous accessors. Default path: track.name. */
export interface DiscreteBindingOptions<T extends DiscreteValue> {
  property?: string;
  get?: () => T;
  set?: (value: T) => void;
}
/** One bound categorical channel, usable by createDiscreteClip and AnimationMixer. */
export interface BoundDiscreteTrack {
  readonly target: object;
  readonly property: string;
  readonly duration: number;
  sample(time: number): DiscreteValue;
  read(): DiscreteValue;
  write(value: DiscreteValue): void;
}
/** Bound boolean/string clip for the optional action mixer. */
export interface DiscreteClip {
  readonly kind: 'discrete';
  readonly name: string;
  readonly duration: number;
  readonly tracks: readonly BoundDiscreteTrack[];
}
/** JSON-compatible categorical track record. */
export interface DiscreteTrackData {
  name: string;
  type: 'bool' | 'string';
  times: readonly number[];
  values: readonly DiscreteValue[];
  interpolation?: typeof InterpolateDiscrete;
}
const invalid = (message: string) => Object.assign(rangeError(message, 'arguments'), { code: 'arguments' });
const finite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw invalid(`Invalid discrete ${label}; pass a finite number`);
  return value;
};
const ordered = (times: ArrayLike<number>) =>
  times.length > 0 && Array.from(times).every((t, i) => Number.isFinite(t) && (i === 0 || t > times[i - 1]));
function pathBinding(root: object, path: string): { target: object; property: string } {
  if (!root || typeof root !== 'object' || typeof path !== 'string' || !path)
    throw invalid('Invalid discrete binding; pass an object and a nonempty property path');
  const pattern = /\.?([A-Za-z_$][\w$]*|\d+)|\[(?:(\d+)|"([^"\\]+)"|'([^'\\]+)')\]/gy;
  const parts: string[] = [];
  for (let at = 0; at < path.length; ) {
    pattern.lastIndex = at;
    const match = pattern.exec(path);
    if (!match) throw invalid('Invalid discrete property path; use dot names or quoted/numeric brackets');
    const key = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (['__proto__', 'prototype', 'constructor'].includes(key))
      throw invalid('Unsafe discrete property path; choose an ordinary data property');
    parts.push(key);
    at = pattern.lastIndex;
  }
  let target = root;
  for (const key of parts.slice(0, -1)) {
    const next = Reflect.get(target, key);
    if (!next || typeof next !== 'object')
      throw invalid(`Missing discrete path ${path}; initialize every containing object before binding`);
    target = next;
  }
  return { target, property: parts.at(-1)! };
}
abstract class StepTrack<T extends DiscreteValue> {
  /** Step interpolation is the only supported mode. */
  readonly DefaultInterpolation = InterpolateDiscrete;
  /** Values use ordinary arrays so booleans and strings retain their types. */
  readonly ValueBufferType = Array;
  /** Double-precision key times preserve authored boundary positions. */
  readonly TimeBufferType = Float64Array;
  protected keyTimes: Float64Array;
  protected keyValues: readonly T[];
  /** Categorical value type. */
  abstract readonly ValueTypeName: 'bool' | 'string';
  constructor(
    readonly name: string,
    times: ArrayLike<number>,
    values: readonly T[],
    private readonly valueType: 'boolean' | 'string',
  ) {
    if (
      typeof name !== 'string' ||
      !name ||
      !times ||
      !Array.isArray(values) ||
      times.length !== values.length ||
      !ordered(times) ||
      Array.from(values).some((v) => typeof v !== valueType)
    )
      throw invalid(
        `Invalid ${valueType} keyframes; pass a name, strictly increasing finite times and one ${valueType} per time`,
      );
    this.keyTimes = Float64Array.from(times);
    this.keyValues = Object.freeze([...values]);
  }
  /** Owned key times in seconds. Treat this view as read-only; use editing methods. */
  get times(): Float64Array {
    return this.keyTimes;
  }
  /** Frozen key values, copied from input. */
  get values(): readonly T[] {
    return this.keyValues;
  }
  /** One categorical value per key. */
  getValueSize(): number {
    return 1;
  }
  /** Always InterpolateDiscrete. */
  getInterpolation(): typeof InterpolateDiscrete {
    return InterpolateDiscrete;
  }
  /** Reject non-step interpolation rather than coercing categorical values. */
  setInterpolation(mode: number): this {
    if (mode !== InterpolateDiscrete)
      throw invalid('Categorical tracks require InterpolateDiscrete; use a numeric track for interpolation');
    return this;
  }
  /** Hold the last key at or before time, clamping outside the key range. Exact key times select that key. */
  sample(time: number): T {
    finite(time, 'sample time');
    let lo = 0,
      hi = this.keyTimes.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.keyTimes[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    return this.keyValues[lo];
  }
  /** Familiar interpolant interface; evaluate reuses one output array. */
  createInterpolant(result: T[] = []): { evaluate(time: number): T[] } {
    if (!Array.isArray(result))
      throw invalid('Categorical interpolation needs a plain array; numeric buffers coerce boolean/string values');
    return {
      evaluate: (time: number) => {
        result[0] = this.sample(time);
        return result;
      },
    };
  }
  /** Validate retained buffers after external inspection. */
  validate(): boolean {
    return (
      ordered(this.keyTimes) &&
      this.keyTimes.length === this.keyValues.length &&
      this.keyValues.every((v) => typeof v === this.valueType)
    );
  }
  /** Shift all key times, rejecting precision collapse before changing them. */
  shift(offset: number): this {
    finite(offset, 'offset');
    const times = Float64Array.from(this.keyTimes, (t) => t + offset);
    if (!ordered(times)) throw invalid('Discrete shift loses time ordering; use a smaller finite offset');
    this.keyTimes = times;
    return this;
  }
  /**
   * Scale time; a negative factor mirrors the track so it plays the original backwards. Zero is invalid. Under
   * hold-last sampling the value held over (t[i], t[i+1]] moves to the key at -t[i+1], so values shift by one key:
   * the original last value, held there for an instant only, is not kept.
   */
  scale(factor: number): this {
    finite(factor, 'scale');
    if (!factor) throw invalid('Discrete scale must be nonzero; use action timeScale to pause');
    const times = Float64Array.from(this.keyTimes, (t) => t * factor + 0); // + 0 turns -0 into 0
    if (factor < 0) times.reverse();
    if (!ordered(times))
      throw invalid('Discrete scale loses time ordering; use a finite factor that preserves distinct keys');
    this.keyTimes = times;
    if (factor < 0) {
      const v = this.keyValues,
        n = v.length;
      this.keyValues = Object.freeze(v.map((_, j) => v[j < n - 1 ? n - 2 - j : 0]));
    }
    return this;
  }
  /** Clip to inclusive bounds, inserting held boundary samples so no categorical state is lost. */
  trim(start: number, end: number): this {
    finite(start, 'trim start');
    finite(end, 'trim end');
    if (end < start) throw invalid('Discrete trim end precedes start; pass start <= end');
    const times = [start],
      values = [this.sample(start)];
    for (let i = 0; i < this.keyTimes.length; i++)
      if (this.keyTimes[i] > start && this.keyTimes[i] < end) {
        times.push(this.keyTimes[i]);
        values.push(this.keyValues[i]);
      }
    if (end > start) {
      times.push(end);
      values.push(this.sample(end));
    }
    this.keyTimes = Float64Array.from(times);
    this.keyValues = Object.freeze(values);
    return this;
  }
  /** Remove redundant held keys, preserving the first and last key/duration. */
  optimize(): this {
    const times: number[] = [],
      values: T[] = [];
    for (let i = 0; i < this.keyTimes.length; i++)
      if (i === 0 || i === this.keyTimes.length - 1 || this.keyValues[i] !== this.keyValues[i - 1]) {
        times.push(this.keyTimes[i]);
        values.push(this.keyValues[i]);
      }
    this.keyTimes = Float64Array.from(times);
    this.keyValues = Object.freeze(values);
    return this;
  }
  /** Serialize a track without executable accessors. */
  toJSON(): DiscreteTrackData {
    return {
      name: this.name,
      type: this.ValueTypeName,
      times: Array.from(this.keyTimes),
      values: [...this.keyValues],
      interpolation: InterpolateDiscrete,
    };
  }
  /** Bind a property once, or supply explicit get/set. Bind again after editing keys or replacing a containing object. */
  bind(root: object, options: DiscreteBindingOptions<T> = {}): BoundDiscreteTrack {
    const path = options.property ?? this.name;
    const resolved = options.get && options.set ? { target: root, property: path } : pathBinding(root, path);
    if (!resolved.target || typeof resolved.target !== 'object')
      throw invalid('Discrete accessor binding needs an object identity; pass its owner');
    const read = (): T => {
      const value = options.get ? options.get() : Reflect.get(resolved.target, resolved.property);
      if (typeof value !== this.valueType)
        throw invalid(
          `Discrete ${path} has the wrong type; initialize a ${this.valueType} property or provide get/set`,
        );
      return value as T;
    };
    read();
    return {
      ...resolved,
      duration: Math.max(0, this.keyTimes.at(-1)!),
      sample: (time) => this.sample(time),
      read,
      write: (value) => {
        if (typeof value !== this.valueType)
          throw invalid(`Discrete ${path} needs a ${this.valueType}; keep the binding value type`);
        if (options.set) options.set(value as T);
        else if (!Reflect.set(resolved.target, resolved.property, value))
          throw invalid(`Discrete ${path} is read-only; provide an explicit setter`);
      },
    };
  }
}
/** Step-sampled visibility and other boolean flags. */
export class BooleanKeyframeTrack extends StepTrack<boolean> {
  readonly ValueTypeName = 'bool' as const;
  constructor(name: string, times: ArrayLike<number>, values: readonly boolean[]) {
    super(name, times, values, 'boolean');
  }
  /** Independent copy of this track and its key buffers. */
  clone(): BooleanKeyframeTrack {
    return new BooleanKeyframeTrack(this.name, this.times, this.values);
  }
}
/** Step-sampled text, labels and other string properties. */
export class StringKeyframeTrack extends StepTrack<string> {
  readonly ValueTypeName = 'string' as const;
  constructor(name: string, times: ArrayLike<number>, values: readonly string[]) {
    super(name, times, values, 'string');
  }
  /** Independent copy of this track and its key buffers. */
  clone(): StringKeyframeTrack {
    return new StringKeyframeTrack(this.name, this.times, this.values);
  }
}
/** Restore JSON data as a typed categorical track. */
export function parseDiscreteTrack(data: DiscreteTrackData): BooleanKeyframeTrack | StringKeyframeTrack {
  if (!data || (data.type !== 'bool' && data.type !== 'string'))
    throw invalid('Unknown discrete track type; choose bool or string');
  const track =
    data.type === 'bool'
      ? new BooleanKeyframeTrack(data.name, data.times, data.values as boolean[])
      : new StringKeyframeTrack(data.name, data.times, data.values as string[]);
  return track.setInterpolation(data.interpolation ?? InterpolateDiscrete);
}
/** Create a bound action clip. Highest effective action weight wins each categorical property; ties use the later action. */
export function createDiscreteClip(name: string, tracks: readonly BoundDiscreteTrack[]): DiscreteClip {
  if (typeof name !== 'string' || !name || !Array.isArray(tracks) || !tracks.length)
    throw invalid('Discrete clip needs a name and bound tracks; call track.bind(target) first');
  const seen = new Map<object, Set<string>>();
  let duration = 0;
  for (const track of tracks) {
    if (
      !track ||
      typeof track.sample !== 'function' ||
      typeof track.read !== 'function' ||
      typeof track.write !== 'function' ||
      !track.target ||
      typeof track.target !== 'object' ||
      typeof track.property !== 'string' ||
      !Number.isFinite(track.duration) ||
      track.duration < 0
    )
      throw invalid('Invalid discrete clip channel; use track.bind(target)');
    const original = track.read();
    if (typeof original !== 'boolean' && typeof original !== 'string')
      throw invalid('Discrete clip channels need boolean or string originals; use a numeric clip for numbers');
    let paths = seen.get(track.target);
    if (!paths) seen.set(track.target, (paths = new Set()));
    if (paths.has(track.property)) throw invalid('Duplicate discrete clip target; use one track per property');
    paths.add(track.property);
    duration = Math.max(duration, track.duration);
  }
  return Object.freeze({ kind: 'discrete', name, duration, tracks: Object.freeze([...tracks]) });
}
