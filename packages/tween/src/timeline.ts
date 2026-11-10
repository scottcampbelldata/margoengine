import { MargoError } from '@margoengine/math/errors';
import { linear, type Easing } from './index.js';

/** Options for {@link Timeline.to}. */
export interface TimelineTweenOptions {
  /** Length in seconds, finite and >= 0. */
  duration: number;
  /** Start time on the timeline: seconds, or a label name (optionally `'label+0.5'` / `'label-0.5'`). Default: right after the previous entry ends. */
  at?: number | string;
  /** Easing curve. Default linear. */
  easing?: Easing;
}

/** Options for the {@link Timeline} constructor. */
export interface TimelineOptions {
  /** Extra plays after the first; `Infinity` loops forever. Default 0. */
  repeat?: number;
  /** Play backwards on every second pass instead of jumping back to the start. Default false. */
  yoyo?: boolean;
  /** Playback speed multiplier, > 0. Default 1. */
  speed?: number;
  /** Called once when playback ends (never for an endless repeat, or when paused/cancelled). */
  onComplete?: () => void;
}

interface Entry {
  target: Record<string, number>;
  key: string;
  to: number;
  start: number;
  duration: number;
  easing: Easing;
  from: number;
  captured: boolean;
}
interface Call {
  at: number;
  fn: () => void;
}

/**
 * A sequence of tweens and callbacks on one clock, with labels, seeking, pause, speed, repeat and yoyo. A property's
 * start value is read the first time the timeline reaches its entry, so entries chain naturally; seeking back puts
 * values back where they were.
 *
 * ```ts
 * const t = new Timeline()
 *   .to(door, 'angle', 1.5, {duration: 0.6})
 *   .label('open')
 *   .to(light, 'intensity', 3, {duration: 0.4, at: 'open'})
 *   .call(() => console.log('done'));
 * t.play();
 * // each frame: t.update(deltaSeconds)
 * ```
 */
export class Timeline {
  private readonly entries: Entry[] = [];
  private readonly calls: Call[] = [];
  private readonly labels = new Map<string, number>();
  private end = 0;
  private position = 0;
  private direction = 1;
  /** Yoyo leg: -1 on a backward pass. Kept apart from direction so a replay starts the way reverse() set. */
  private leg = 1;
  private left: number;
  private running = false;
  private finished = false;
  private updating = false;
  private began = false;
  private wrap = false;
  speed: number;
  constructor(private readonly options: TimelineOptions = {}) {
    const { repeat = 0, speed = 1, onComplete } = options;
    if (
      (!Number.isFinite(repeat) && repeat !== Infinity) ||
      repeat < 0 ||
      !Number.isFinite(speed) ||
      speed <= 0 ||
      (onComplete !== undefined && typeof onComplete !== 'function')
    )
      throw new RangeError('Invalid timeline options; use repeat >= 0, speed > 0 and a function for onComplete');
    this.left = repeat;
    this.speed = speed;
  }
  /** Total length in seconds of one pass. */
  get duration(): number {
    return this.end;
  }
  /** Current time within the pass, in seconds. */
  get time(): number {
    return this.position;
  }
  /** True while playing (between `play()` and the end or `pause()`). */
  get playing(): boolean {
    return this.running;
  }
  private resolve(at: number | string | undefined): number {
    if (at === undefined) return this.end;
    if (typeof at === 'number') {
      if (!Number.isFinite(at) || at < 0)
        throw new RangeError('Timeline times must be finite and >= 0; pass seconds or a label name');
      return at;
    }
    const m = /^(.*?)([+-]\d+(?:\.\d+)?)?$/.exec(at)!,
      base = this.labels.get(m[1]);
    if (base === undefined) throw new RangeError(`Unknown timeline label "${m[1]}"; add it with label() first`);
    const time = base + (m[2] ? Number(m[2]) : 0);
    if (time < 0) throw new RangeError('Timeline label offset ends before 0; use a later label or a smaller offset');
    return time;
  }
  private assertEditable(): void {
    if (this.updating)
      throw new MargoError('state', 'Cannot edit a timeline from its own callback; edit it after update() returns');
  }
  /**
   * Add a tween of `target[key]` to `to`.
   * @throws RangeError for a non-finite value, a bad duration or time, or an unknown label.
   * @throws MargoError `'state'` when called from a timeline callback.
   */
  to(
    target: Record<string, number>,
    key: string,
    to: number,
    { duration, at, easing = linear }: TimelineTweenOptions,
  ): this {
    this.assertEditable();
    if (!Number.isFinite(to) || !Number.isFinite(duration) || duration < 0 || typeof easing !== 'function')
      throw new RangeError('Invalid timeline tween; use a finite end value, a duration >= 0 and an easing function');
    const start = this.resolve(at);
    this.entries.push({ target, key, to, start, duration, easing, from: 0, captured: false });
    this.end = Math.max(this.end, start + duration);
    return this;
  }
  /** Run `fn` when playback passes `at` (seconds or a label; default the current end). Not run by `seek`. */
  call(fn: () => void, at?: number | string): this {
    this.assertEditable();
    if (typeof fn !== 'function') throw new TypeError('call() needs a function; pass () => { ... }');
    const time = this.resolve(at);
    this.calls.push({ at: time, fn });
    this.end = Math.max(this.end, time);
    return this;
  }
  /** Name a time (default the current end) so later entries can start `at` it. */
  label(name: string, at?: number | string): this {
    this.assertEditable();
    if (!name) throw new TypeError('A label needs a name; pass a non-empty string');
    this.labels.set(name, this.resolve(at));
    return this;
  }
  /** Start or resume playing; restarts from the beginning after the end was reached. */
  play(): this {
    if (this.finished) {
      this.finished = false;
      this.left = this.options.repeat ?? 0;
      this.leg = 1;
      this.seek(this.direction > 0 ? 0 : this.end);
    }
    this.running = true;
    return this;
  }
  /** Stop advancing; values stay where they are. */
  pause(): this {
    this.running = false;
    return this;
  }
  /** Flip the playing direction (forward to backward and back). */
  reverse(): this {
    this.direction = -this.direction;
    this.finished = false;
    return this;
  }
  /**
   * Jump to `time` (clamped to 0..duration) and write every value for that time. Callbacks are not run.
   * @throws RangeError when `time` is not finite.
   */
  seek(time: number): this {
    if (!Number.isFinite(time)) throw new RangeError('seek needs a finite time in seconds');
    this.wrap = false;
    this.position = Math.min(this.end, Math.max(0, time));
    this.began = this.position > 0;
    this.apply();
    return this;
  }
  private apply(): void {
    const time = this.position;
    // Put back entries the playhead has not reached, last first, so earlier entries on the same property win.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (time < e.start && e.captured) e.target[e.key] = e.from;
    }
    for (const e of this.entries) {
      if (time < e.start) continue;
      if (!e.captured) {
        e.from = e.target[e.key];
        e.captured = true;
        if (!Number.isFinite(e.from))
          throw new RangeError('Timeline target values must be finite numbers; initialise the property first');
      }
      const t = e.duration ? Math.min(1, (time - e.start) / e.duration) : 1;
      e.target[e.key] = t >= 1 ? e.to : e.from + (e.to - e.from) * e.easing(t);
    }
  }
  /**
   * Advance by `delta` seconds (scaled by `speed`), writing values and running callbacks passed on the way.
   * @throws RangeError for a negative or non-finite delta.
   * @throws MargoError `'state'` when called from a timeline callback.
   */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid timeline delta; pass seconds as a finite number >= 0');
    this.assertEditable();
    if (!this.running) return;
    this.updating = true;
    try {
      if (this.wrap) {
        // Loop back lazily, so the last value of a pass stays visible until the next update.
        this.wrap = false;
        this.position = this.direction * this.leg > 0 ? 0 : this.end;
        this.began = false;
        this.apply();
      }
      const way = this.direction * this.leg,
        from = this.position,
        step = delta * this.speed * way,
        to = Math.min(this.end, Math.max(0, from + step));
      this.position = to;
      this.apply();
      for (const call of this.calls)
        if (
          way > 0
            ? (call.at > from || (!this.began && call.at === 0)) && call.at <= to
            : call.at < from && call.at >= to
        )
          call.fn();
      this.began = true;
      if (to !== (way > 0 ? this.end : 0) || (step === 0 && this.end > 0)) return;
      if (this.left > 0) {
        if (this.left !== Infinity) this.left--;
        if (this.options.yoyo) this.leg = -this.leg;
        else this.wrap = true;
        return;
      }
      this.running = false;
      this.finished = true;
      this.options.onComplete?.();
    } finally {
      this.updating = false;
    }
  }
}
