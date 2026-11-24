import {
  Tween,
  Timeline,
  type TweenOptions,
  type ArrayTweenOptions,
  type TimelineOptions,
  type TimelineTweenOptions,
} from './index.js';
import { MargoError } from '@margoengine/math/errors';

/** Timing options with cooperative cancellation. An abort preserves the current value. */
export interface AsyncTweenOptions extends TweenOptions {
  /** Cancels this operation and rejects with signal.reason. Default none. */
  signal?: AbortSignal;
}
/** Array interpolation and cooperative cancellation. */
export interface AsyncArrayTweenOptions extends ArrayTweenOptions {
  /** Cancels this operation and rejects with signal.reason. Default none. */
  signal?: AbortSignal;
}
/** A cancel function that can also be awaited. Always attach a rejection handler if it can be cancelled. */
export interface TweenTask extends PromiseLike<void>, Disposable {
  (): void;
  /** Resolves on completion; rejects on abort, replacement, clear, or an update error. */
  readonly finished: Promise<void>;
  /** Cancel, leaving the current value in place. Default reason is AbortError. */
  cancel(reason?: unknown): void;
}
type Pending = { driver: Tween; target?: object; key?: string; task: TweenTask; done: boolean };
const cancelled = () => new DOMException('Animation cancelled', 'AbortError');

/** Awaitable tweens. The caller still owns the frame clock; this module starts no timers. */
export class AsyncTween extends Tween implements PromiseLike<void>, Disposable {
  private readonly pending: Pending[] = [];
  private stepping = false;

  private start(
    target: object | undefined,
    key: string | undefined,
    options: AsyncTweenOptions,
    build: (driver: Tween, options: TweenOptions) => () => void,
  ): TweenTask {
    let resolve!: () => void, reject!: (reason: unknown) => void;
    const finished = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const driver = new Tween();
    let stop = () => {};
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    const settle = (failed: boolean, reason?: unknown) => {
      if (entry.done) return;
      entry.done = true;
      cleanup();
      stop();
      if (failed) reject(reason);
      else resolve();
    };
    const task = Object.assign(() => settle(true, cancelled()), {
      finished,
      then: finished.then.bind(finished),
      cancel: (reason: unknown = cancelled()) => settle(true, reason),
      [Symbol.dispose]: () => settle(true, cancelled()),
    });
    const entry: Pending = { driver, target, key, task, done: false };
    const abort = () => task.cancel(options.signal!.reason);
    // Validate/create before replacing anything. A rejected input never kills valid work.
    stop = build(driver, {
      ...options,
      onComplete: () => {
        if (entry.done) return;
        entry.done = true;
        cleanup();
        stop();
        try {
          options.onComplete?.();
        } catch (error) {
          reject(error);
          throw error;
        }
        resolve();
      },
    });
    if (options.signal?.aborted) task.cancel(options.signal.reason);
    else {
      if (target)
        for (const old of this.pending) if (old.target === target && old.key === key && !old.done) old.task.cancel();
      this.pending.push(entry);
      options.signal?.addEventListener('abort', abort, { once: true });
    }
    return task;
  }
  /** Animate a numeric property; replacement rejects the previous task with AbortError. */
  override to(target: Record<string, number>, key: string, value: number, options: AsyncTweenOptions): TweenTask {
    return this.start(target, key, options, (driver, timing) => driver.to(target, key, value, timing));
  }
  /** Animate an array in place; supports custom interpolation and AbortSignal. */
  override array(
    target: number[] | Float32Array | Float64Array,
    value: ArrayLike<number>,
    options: AsyncArrayTweenOptions,
  ): TweenTask {
    return this.start(target, undefined, options, (driver, timing) =>
      driver.array(target, value, { ...timing, interpolate: options.interpolate }),
    );
  }
  /** Animate a path, preserving the last written point on cancellation. */
  override path(
    target: number[] | Float32Array | Float64Array,
    path: (t: number, out: number[]) => number[],
    options: AsyncTweenOptions,
  ): TweenTask {
    return this.start(target, undefined, options, (driver, timing) => driver.path(target, path, timing));
  }
  /** Await any progress-driven operation, including colours and rotations. */
  override custom(apply: (progress: number) => void, options: AsyncTweenOptions): TweenTask {
    return this.start(undefined, undefined, options, (driver, timing) => driver.custom(apply, timing));
  }
  /** Advance operations present at the start of this update. Failures reject their task and propagate. */
  override update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Tween delta must be finite and >= 0');
    if (this.stepping) throw new MargoError('state', 'Recursive AsyncTween.update; call update after the callback returns');
    this.stepping = true;
    const count = this.pending.length;
    try {
      for (let i = 0; i < count; i++) {
        const entry = this.pending[i];
        if (entry.done) continue;
        try {
          entry.driver.update(delta);
        } catch (error) {
          entry.task.cancel(error);
          throw error;
        }
      }
    } finally {
      this.stepping = false;
      this.compact();
    }
  }
  /** Drop settled operations without allocating a new list. */
  override compact(): void {
    if (this.stepping) throw new MargoError('state', 'Cannot compact during an update; call compact after update returns');
    let count = 0;
    for (const entry of this.pending) if (!entry.done) this.pending[count++] = entry;
    this.pending.length = count;
  }
  /** Cancel every active operation. Each unfinished task rejects with AbortError. */
  override clear(): void {
    for (const entry of this.pending) entry.task.cancel();
    if (!this.stepping) this.pending.length = 0;
  }
  /** Await the operations currently active; operations added later are independent. */
  get finished(): Promise<void> {
    return Promise.all(this.pending.map((entry) => entry.task.finished)).then(() => {});
  }
  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.finished.then(onfulfilled, onrejected);
  }
  /** Cancel all unfinished operations. */
  [Symbol.dispose](): void {
    this.clear();
  }
}

/** Timeline options with AbortSignal. */
export interface AsyncTimelineOptions extends TimelineOptions {
  /** Abort pauses playback and rejects finished with signal.reason. Default none. */
  signal?: AbortSignal;
}
/** A root Timeline with a completion promise, renewed whenever a settled run is played again. */
export class AsyncTimeline implements PromiseLike<void>, Disposable {
  private readonly timeline: Timeline;
  private resolve!: () => void;
  private reject!: (reason: unknown) => void;
  private settled = false;
  private promise!: Promise<void>;
  private readonly signal?: AbortSignal;
  private readonly abort = () => this.cancel(this.signal!.reason);
  constructor(options: AsyncTimelineOptions = {}) {
    let complete!: () => void;
    this.timeline = new Timeline({ ...options, onComplete: () => complete() });
    complete = () => {
      if (this.settled) return;
      try {
        options.onComplete?.();
      } catch (error) {
        this.cancel(error);
        throw error;
      }
      if (!this.settled) {
        this.settled = true;
        this.detach();
        this.resolve();
      }
    };
    this.signal = options.signal;
    this.resetPromise();
  }
  private detach(): void {
    this.signal?.removeEventListener('abort', this.abort);
  }
  private resetPromise(): void {
    this.settled = false;
    this.promise = new Promise<void>((yes, no) => {
      this.resolve = yes;
      this.reject = no;
    });
    if (this.signal?.aborted) this.cancel(this.signal.reason);
    else this.signal?.addEventListener('abort', this.abort, { once: true });
  }
  /** Promise for this run. Pause and seek do not settle it. */
  get finished(): Promise<void> {
    return this.promise;
  }
  /** One pass in seconds. */
  get duration(): number {
    return this.timeline.duration;
  }
  /** Current playhead in seconds. */
  get time(): number {
    return this.timeline.time;
  }
  /** Whether the clock is advancing. */
  get playing(): boolean {
    return this.timeline.playing;
  }
  /** Playback speed, default 1. */
  get speed(): number {
    return this.timeline.speed;
  }
  set speed(value: number) {
    this.timeline.speed = value;
  }
  /** Add a numeric property tween. */
  to(target: Record<string, number>, key: string, value: number, options: TimelineTweenOptions): this {
    this.timeline.to(target, key, value, options);
    return this;
  }
  /** Add a named time. */
  label(name: string, at?: number | string): this {
    this.timeline.label(name, at);
    return this;
  }
  /** Add a playback callback (not fired on seek). */
  call(callback: () => void, at?: number | string): this {
    if (typeof callback !== 'function') throw new TypeError('call needs a function; pass a callback');
    this.timeline.call(() => { if (!this.settled) callback(); }, at);
    return this;
  }
  /** Seek without settling the promise. */
  seek(time: number): this {
    this.timeline.seek(time);
    return this;
  }
  /** Reverse playback direction. */
  reverse(): this {
    this.timeline.reverse();
    return this;
  }
  /** Pause without settling the promise. */
  pause(): this {
    this.timeline.pause();
    return this;
  }
  /** Resume or replay; replay creates a fresh completion promise. */
  play(): this {
    if (this.settled) this.resetPromise();
    if (!this.settled) this.timeline.play();
    return this;
  }
  /** Advance the caller-owned clock, rejecting and propagating any update failure. */
  update(delta: number): void {
    try {
      this.timeline.update(delta);
    } catch (error) {
      this.cancel(error);
      throw error;
    }
  }
  /** Pause and reject once, preserving the current values. */
  cancel(reason: unknown = cancelled()): void {
    this.pause();
    if (this.settled) return;
    this.settled = true;
    this.detach();
    this.reject(reason);
  }
  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.finished.then(onfulfilled, onrejected);
  }
  /** Cancel unfinished playback. */
  [Symbol.dispose](): void {
    this.cancel();
  }
}
