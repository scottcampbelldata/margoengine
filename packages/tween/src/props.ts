import { AsyncTween, type AsyncTweenOptions, type TweenTask } from './async.js';
import { linear, type Easing } from './index.js';

/** A numeric destination or relative displacement. */
export type PropertyValue = number | `+=${number}` | `-=${number}` | `*=${number}` | `/=${number}`;
/** Numeric writable properties; lists give explicit evenly spaced keyframes. */
export type PropertyValues<T extends object> = { [K in keyof T as T[K] extends number ? K : never]?: PropertyValue | readonly PropertyValue[] };
/** A keyframe at a normalized offset; missing offsets are evenly distributed between explicit offsets. */
export interface PropertyKeyframe<T extends object> {
  /** Values at this key; omitted properties carry their previous value. */
  values: PropertyValues<T>;
  /** Position from 0 to 1, nondecreasing. Default distributed. */
  offset?: number;
  /** Easing from this key to the next. Default the operation easing, or linear. */
  easing?: Easing;
}
type Channel = { key: string; values: number[]; offsets: number[]; easings: Easing[] };
function numeric(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('Property tween values must be finite numbers');
  return value;
}
function relative(value: PropertyValue, base: number): number {
  if (typeof value === 'number') return numeric(value);
  const match = /^([+\-*/])=([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.exec(value);
  if (!match) throw new RangeError('Relative values need +=, -=, *= or /= and a finite number');
  const amount = numeric(Number(match[2]));
  return numeric(match[1] === '+' ? base + amount : match[1] === '-' ? base - amount : match[1] === '*' ? base * amount : base / amount);
}
const record = (target: object) => target as Record<string, unknown>;

/** A multi-property operation with its own caller-driven clock. Await it, or finished, for completion. */
export interface PropertyTween extends PromiseLike<void>, Disposable {
  /** The animated object or vector. */
  readonly target: object;
  /** Properties affected by this operation. */
  readonly keys: readonly string[];
  /** One iteration in seconds, without delay/repeat. */
  readonly duration: number;
  /** Completion promise; cancellation rejects it. */
  readonly finished: Promise<void>;
  /** Local playback multiplier >= 0, default 1. */
  speed: number;
  /** Advance the caller-owned clock. */
  update(delta: number): void;
  /** Pause only this operation. */
  pause(): this;
  /** Resume the operation. */
  play(): this;
  /** Cancel with AbortError by default, preserving values. */
  cancel(reason?: unknown): void;
}
class PropertyOperation implements PropertyTween {
  private readonly driver = new AsyncTween();
  private readonly task: TweenTask;
  private paused = false;
  private scale = 1;
  /** Properties affected by this operation. */
  readonly keys: readonly string[];
  /** One iteration in seconds, without delay/repeat. */
  readonly duration: number;
  /** Compile with the factory functions to, from, fromTo or keyframes. */
  constructor(readonly target: object, channels: Channel[], options: AsyncTweenOptions, immediate: boolean) {
    this.keys = Object.freeze(channels.map((channel) => channel.key));
    this.duration = options.duration;
    const apply = (progress: number) => {
      for (const channel of channels) {
        const { values, offsets, easings, key } = channel;
        let index = 0;
        while (index < offsets.length - 2 && progress >= offsets[index + 1]) index++;
        const span = offsets[index + 1] - offsets[index];
        const phase = span ? Math.max(0, Math.min(1, (progress - offsets[index]) / span)) : 1;
        const t = phase === 0 || phase === 1 ? phase : easings[index](phase);
        if (!Number.isFinite(t)) throw new RangeError('Property easing must return a finite number');
        record(target)[key] = t === 0 ? values[index] : t === 1 ? values[index + 1] : values[index] * (1 - t) + values[index + 1] * t;
      }
    };
    this.task = this.driver.custom(apply, { ...options, easing: linear });
    if (immediate && !options.signal?.aborted) apply(0);
  }
  /** Promise for this operation. Cancellation rejects it. */
  get finished(): Promise<void> { return this.task.finished; }
  /** Playback multiplier >= 0; zero holds the value. Default 1. */
  get speed(): number { return this.scale; }
  set speed(value: number) { if (!Number.isFinite(value) || value < 0) throw new RangeError('speed must be finite and >= 0'); this.scale = value; }
  /** Advance by nonnegative finite seconds unless paused. */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('delta must be finite and >= 0');
    if (!this.paused && this.scale > 0) this.driver.update(delta * this.scale);
  }
  /** Pause only this operation. */
  pause(): this { this.paused = true; return this; }
  /** Resume from the current value. */
  play(): this { this.paused = false; return this; }
  /** Cancel with AbortError by default, preserving current values. */
  cancel(reason?: unknown): void { this.task.cancel(reason); }
  then<TResult1 = void, TResult2 = never>(onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> { return this.finished.then(onfulfilled, onrejected); }
  /** Cancel unfinished work. */
  [Symbol.dispose](): void { this.cancel(); }
}

function compile<T extends object>(target: T, values: PropertyValues<T>, mode: 'to' | 'from' | 'fromTo', options: AsyncTweenOptions, start?: PropertyValues<T>): PropertyTween {
  if (options.easing !== undefined && typeof options.easing !== 'function') throw new RangeError('Property easing must be a function');
  const channels: Channel[] = [];
  const ends = values as Record<string, PropertyValue | readonly PropertyValue[]>;
  const starts = start as Record<string, PropertyValue | readonly PropertyValue[]> | undefined;
  const keys = new Set([...Object.keys(ends), ...Object.keys(starts ?? {})]);
  for (const key of keys) {
    const current = numeric(record(target)[key]);
    const initial = starts?.[key];
    if (Array.isArray(initial)) throw new RangeError('fromTo start values must be scalar');
    const base = initial === undefined ? current : relative(initial as PropertyValue, current);
    const value = ends[key] ?? current;
    let points: number[];
    if (Array.isArray(value)) {
      if (value.length < 2) throw new RangeError('Property keyframe lists need at least two values');
      points = [];
      for (const item of value) points.push(relative(item, points.at(-1) ?? base));
      if (mode === 'from') points.reverse();
    } else {
      const end = relative(value as PropertyValue, base);
      points = mode === 'from' ? [end, current] : [base, end];
    }
    channels.push({ key, values: points, offsets: points.map((_, i) => i / (points.length - 1)), easings: points.map(() => options.easing ?? linear) });
  }
  if (!channels.length) throw new RangeError('A property tween needs at least one numeric property');
  return new PropertyOperation(target, channels, options, mode !== 'to' || Object.values(ends).some(Array.isArray));
}
/** Animate object/vector properties to destinations, relative values or explicit keyframe lists. */
export function to<T extends object>(target: T, values: PropertyValues<T>, options: AsyncTweenOptions): PropertyTween { return compile(target, values, 'to', options); }
/** Animate from supplied values to the target's current values; renders the start immediately. */
export function from<T extends object>(target: T, values: PropertyValues<T>, options: AsyncTweenOptions): PropertyTween { return compile(target, values, 'from', options); }
/** Animate explicit start and end values; renders the start immediately. */
export function fromTo<T extends object>(target: T, start: PropertyValues<T>, end: PropertyValues<T>, options: AsyncTweenOptions): PropertyTween { return compile(target, end, 'fromTo', options, start); }
/** Animate a list of multi-property keys, including offsets and per-segment easing. */
export function keyframes<T extends object>(target: T, frames: readonly PropertyKeyframe<T>[], options: AsyncTweenOptions): PropertyTween {
  if (options.easing !== undefined && typeof options.easing !== 'function') throw new RangeError('Property easing must be a function');
  if (frames.length < 2) throw new RangeError('Keyframes need at least two frames');
  if (frames.some((frame) => frame.easing !== undefined && typeof frame.easing !== 'function')) throw new RangeError('Keyframe easing must be a function');
  const offsets = frames.map((frame) => frame.offset);
  offsets[0] ??= 0;
  offsets[offsets.length - 1] ??= 1;
  let previous = 0;
  for (let i = 0; i < offsets.length; i++) {
    const offset = offsets[i];
    if (offset === undefined) continue;
    if (!Number.isFinite(offset) || offset < 0 || offset > 1 || offset < offsets[previous]!) throw new RangeError('Keyframe offsets must be ordered in 0..1');
    for (let j = previous + 1; j < i; j++) offsets[j] = offsets[previous]! + (offset - offsets[previous]!) * (j - previous) / (i - previous);
    previous = i;
    if (frames[i].easing !== undefined && typeof frames[i].easing !== 'function') throw new RangeError('Keyframe easing must be a function');
  }
  const keys = new Set(frames.flatMap((frame) => Object.keys(frame.values)));
  const channels: Channel[] = [];
  for (const key of keys) {
    let value = numeric(record(target)[key]);
    const values: number[] = [];
    for (const frame of frames) {
      const next = (frame.values as Record<string, PropertyValue>)[key];
      if (Array.isArray(next)) throw new RangeError('A frame value must be scalar');
      if (next !== undefined) value = relative(next, value);
      values.push(value);
    }
    // Hold endpoint values outside the explicitly specified offset range.
    if (offsets[0]! > 0) values.unshift(values[0]);
    if (offsets.at(-1)! < 1) values.push(values.at(-1)!);
    const times = offsets as number[];
    const positions = [...(times[0] > 0 ? [0] : []), ...times, ...(times.at(-1)! < 1 ? [1] : [])];
    const easings = frames.map((frame) => frame.easing ?? options.easing ?? linear);
    if (times[0] > 0) easings.unshift(linear);
    channels.push({ key, values, offsets: positions, easings });
  }
  if (!channels.length) throw new RangeError('Keyframes need numeric properties');
  return new PropertyOperation(target, channels, options, true);
}
