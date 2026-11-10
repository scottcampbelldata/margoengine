import { MargoError } from '@margoengine/math/errors';
import { lerpArray } from './interpolate.js';
export * from './easings.js';
export * from './interpolate.js';
export { smoothDamp, type DampArray } from './damp.js';
export { Spring, springOptions, type SpringOptions } from './spring.js';
export { Timeline, type TimelineOptions, type TimelineTweenOptions } from './timeline.js';
/** Maps normalized progress `time` in [0, 1) to eased progress; must return a finite number. */
export type Easing = (time: number) => number;
/** Identity easing: constant speed. The default for `TweenOptions.easing`. */
export const linear: Easing = (t) => t;
/** Smoothstep easing, `t * t * (3 - 2 * t)`: zero slope at both ends. */
export const easeSmoothstep: Easing = (t) => t * t * (3 - 2 * t);
/** Cubic ease-in-out: accelerates to the midpoint, then decelerates. */
export const easeInOutCubic: Easing = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Timing options for {@link Tween.to}. */
export interface TweenOptions {
  /** Length of the tween in seconds; finite and >= 0. Zero jumps to the end value on the first update after the delay. */
  duration: number;
  /** Wait before the tween starts, in seconds; finite and >= 0. Default 0. */
  delay?: number;
  /** Easing curve. Default {@link linear}. */
  easing?: Easing;
  /** Called once when the tween reaches its end value; not called when it is cancelled. */
  onComplete?: () => void;
  /** Extra plays after the first (an integer >= 0, or `Infinity` to loop until cancelled). Default 0. */
  repeat?: number;
  /** With `repeat`, play every second pass backwards so the value swings back and forth. Default false. */
  yoyo?: boolean;
  /** Called at the start of each repeat pass. */
  onRepeat?: () => void;
}
/** Options for {@link Tween.array}: timing plus how to blend the two arrays. */
export interface ArrayTweenOptions extends TweenOptions {
  /** Blend function; default {@link lerpArray}. Pass `slerpArray` for quaternions. */
  interpolate?: (
    out: number[] | Float32Array | Float64Array,
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    t: number,
  ) => void;
}
interface Track {
  target: Record<string, number>;
  key: string;
  from: number;
  to: number;
  duration: number;
  delay: number;
  easing: Easing;
  complete?: () => void;
  apply?: (eased: number) => void;
  cycles: number;
  yoyo: boolean;
  repeated?: () => void;
  cycle: number;
  time: number;
  active: boolean;
}

/** Reuses tracks during updates; adding/removing tracks is outside the hot loop. */
export class Tween {
  private readonly tracks: Track[] = [];
  private updating = false;
  /**
   * Animate `target[key]` from its current value to `to`; replaces any active track on the same target and key.
   * Returns a function that cancels the track.
   * @throws RangeError when the current or end value is not finite, `duration` or `delay` is negative or not finite,
   * or `easing`/`onComplete` is not a function.
   */
  to(target: Record<string, number>, key: string, to: number, options: TweenOptions): () => void {
    const from = target[key];
    if (!Number.isFinite(from) || !Number.isFinite(to))
      throw new RangeError('Tween needs a finite numeric target property and a finite to value; check the arguments.');
    for (const track of this.tracks)
      if (track.active && track.target === target && track.key === key) track.active = false;
    return this.add({ target, key, from, to }, options);
  }
  private add(base: Pick<Track, 'target' | 'key' | 'from' | 'to' | 'apply'>, options: TweenOptions): () => void {
    const { duration, delay = 0, easing = linear, onComplete, repeat = 0, yoyo = false, onRepeat } = options;
    if (
      !Number.isFinite(duration) ||
      duration < 0 ||
      !Number.isFinite(delay) ||
      delay < 0 ||
      typeof easing !== 'function' ||
      (onComplete !== undefined && typeof onComplete !== 'function') ||
      (onRepeat !== undefined && typeof onRepeat !== 'function') ||
      (repeat !== Infinity && (!Number.isInteger(repeat) || repeat < 0)) ||
      typeof yoyo !== 'boolean'
    )
      throw new RangeError(
        'Invalid tween; use finite duration and delay >= 0, an integer repeat >= 0 (or Infinity) and functions for callbacks',
      );
    const track: Track = {
      ...base,
      duration,
      delay,
      easing,
      complete: onComplete,
      repeated: onRepeat,
      cycles: repeat + 1,
      yoyo,
      cycle: 0,
      time: 0,
      active: true,
    };
    this.tracks.push(track);
    return () => {
      track.active = false;
    };
  }
  /**
   * Animate any value you can write from a progress number: `apply` receives the eased progress (0 at the start, 1 at
   * the end, reversed on yoyo passes) every update. Use it for colours, quaternions, CSS, anything. Returns a cancel
   * function.
   * @throws RangeError for invalid timing options or when `apply` is not a function.
   */
  custom(apply: (progress: number) => void, options: TweenOptions): () => void {
    if (typeof apply !== 'function')
      throw new RangeError('Invalid tween; apply must be a function that takes the progress');
    return this.add({ target: {}, key: '', from: 0, to: 1, apply }, options);
  }
  /**
   * Animate an array (a position, a colour, a quaternion) from its current contents to `to`, in place. Blends with
   * `interpolate` (default component-wise lerp; pass `slerpArray` for `[x, y, z, w]` rotations). Replaces any active
   * tween of the same array.
   * @throws RangeError for non-finite values, differing lengths or invalid timing options.
   */
  array(
    target: number[] | Float32Array | Float64Array,
    to: ArrayLike<number>,
    { interpolate = lerpArray, ...options }: ArrayTweenOptions,
  ): () => void {
    if (
      to.length !== target.length ||
      Array.from(target)
        .concat(Array.from(to))
        .some((v) => !Number.isFinite(v))
    )
      throw new RangeError('Invalid tween; the arrays must have the same length and finite numbers');
    for (const track of this.tracks) if (track.active && track.target === (target as unknown)) track.active = false;
    const from = Float64Array.from(target),
      end = Float64Array.from(to);
    const cancel = this.add(
      {
        target: target as unknown as Record<string, number>,
        key: '',
        from: 0,
        to: 1,
        apply: (t) => interpolate(target, from, end, t),
      },
      options,
    );
    return cancel;
  }
  /**
   * Move `target` along `path` (for example from `catmullRomPath`) as the tween progresses; `path(t, out)` must write
   * the point at progress t into `out`.
   * @throws RangeError for invalid timing options.
   */
  path(
    target: number[] | Float32Array | Float64Array,
    path: (t: number, out: number[]) => number[],
    options: TweenOptions,
  ): () => void {
    const scratch = new Array<number>(target.length);
    return this.custom((t) => {
      path(t, scratch);
      for (let i = 0; i < target.length; i++) target[i] = scratch[i];
    }, options);
  }
  /**
   * Advance every active track by `delta` seconds (finite, >= 0), write the values and fire completions, then compact.
   * @throws RangeError for an invalid `delta` or an easing that returns a non-finite value.
   * @throws MargoError `'state'` when called from inside a tween callback.
   */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Tween update delta must be a finite number of 0 or more; pass elapsed seconds.');
    if (this.updating)
      throw new MargoError('state', 'Recursive tween update; do not call update() from a tween callback');
    this.updating = true;
    const count = this.tracks.length;
    try {
      for (let i = 0; i < count; i++) {
        const track = this.tracks[i];
        if (!track.active) continue;
        track.time += delta;
        if (track.time < track.delay) continue;
        const local = track.time - track.delay;
        let t: number, done: boolean;
        if (!track.duration) {
          t = 1;
          done = true;
        } else {
          const total = track.duration * track.cycles;
          done = local >= total;
          const cycle = done ? track.cycles - 1 : Math.floor(local / track.duration);
          if (cycle !== track.cycle) {
            track.cycle = cycle;
            track.repeated?.();
          }
          if (!track.active) continue;
          const phase = done ? 1 : (local - cycle * track.duration) / track.duration;
          t = track.yoyo && cycle % 2 === 1 ? 1 - phase : phase;
        }
        const eased = t === 1 ? 1 : t === 0 ? 0 : track.easing(t);
        if (!Number.isFinite(eased)) throw new RangeError('Easing must return a finite value');
        if (track.apply) track.apply(eased);
        else {
          const span = track.to - track.from;
          track.target[track.key] =
            eased === 1
              ? track.to
              : eased === 0
                ? track.from
                : Number.isFinite(span)
                  ? track.from + span * eased
                  : track.from * (1 - eased) + track.to * eased;
        }
        if (done && track.active) {
          track.active = false;
          track.complete?.();
        }
      }
    } finally {
      this.updating = false;
      this.compact();
    }
  }
  /**
   * Remove finished/cancelled tracks outside the update loop.
   * @throws MargoError `'state'` when called from inside a tween callback.
   */
  compact(): void {
    if (this.updating)
      throw new MargoError('state', 'Cannot compact during tween callbacks; call compact() after update() returns');
    let count = 0;
    for (let i = 0; i < this.tracks.length; i++) if (this.tracks[i].active) this.tracks[count++] = this.tracks[i];
    this.tracks.length = count;
  }
  /** Cancel every track without firing completions; values stay where they are. */
  clear(): void {
    for (const track of this.tracks) track.active = false;
    if (!this.updating) this.tracks.length = 0;
  }
}
