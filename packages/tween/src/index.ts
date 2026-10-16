import { MargoError } from '@margoengine/math/errors';
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
  to(
    target: Record<string, number>,
    key: string,
    to: number,
    { duration, delay = 0, easing = linear, onComplete }: TweenOptions,
  ): () => void {
    const from = target[key];
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      !Number.isFinite(delay) ||
      delay < 0 ||
      typeof easing !== 'function' ||
      (onComplete !== undefined && typeof onComplete !== 'function')
    )
      throw new RangeError('Invalid tween');
    for (const track of this.tracks)
      if (track.active && track.target === target && track.key === key) track.active = false;
    const track: Track = {
      target,
      key,
      from,
      to,
      duration,
      delay,
      easing,
      complete: onComplete,
      time: 0,
      active: true,
    };
    this.tracks.push(track);
    return () => {
      track.active = false;
    };
  }
  /**
   * Advance every active track by `delta` seconds (finite, >= 0), write the values and fire completions, then compact.
   * @throws RangeError for an invalid `delta` or an easing that returns a non-finite value.
   * @throws MargoError `'state'` when called from inside a tween callback.
   */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Invalid tween delta');
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
        const t = track.duration ? Math.min(1, (track.time - track.delay) / track.duration) : 1,
          eased = t === 1 ? 1 : track.easing(t);
        if (!Number.isFinite(eased)) throw new RangeError('Easing must return a finite value');
        const span = track.to - track.from;
        track.target[track.key] =
          t === 1
            ? track.to
            : Number.isFinite(span)
              ? track.from + span * eased
              : track.from * (1 - eased) + track.to * eased;
        if (t === 1) {
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
