/// <reference lib="esnext.disposable" preserve="true" />
// Playback over a Cutscene: a time, a signed speed and the instants passed between updates. All the state a frame
// needs comes from `cutscene.evaluate(time)`, so a player that seeks, scrubs, reverses or skips shows exactly what one
// that played straight to the same time shows; only the events differ (seeking fires none, skipping fires them all).
import { MargoError } from '@margoengine/math/errors';
import { Cutscene, type CutsceneEvent, type CutsceneState, type CutsceneTrackType } from './cutscene.js';
import type { CutsceneDocument } from './document.js';

/** Options of {@link CutscenePlayer}. Every field has a default. */
export interface CutscenePlayerOptions {
  /** Playback rate; negative plays backwards (default 1). */
  speed?: number;
  /** Wrap at the ends instead of finishing (default false). */
  loop?: boolean;
  /** Start time, seconds (default 0). */
  time?: number;
  /** Custom track types the document may use (default none). Ignored when you pass a built {@link Cutscene}. */
  tracks?: readonly CutsceneTrackType[];
}

/** What {@link CutscenePlayer.on} listens to: an instant kind, `'finish'`, or `'*'` for every instant. */
export type CutscenePlayerEvent = CutsceneEvent['kind'] | 'finish' | '*';

/** Largest number of whole loops one `update` may cross. */
const MAX_LOOPS = 100;

/**
 * Plays a {@link Cutscene}: `play()`, `pause()`, `reverse()`, `speed`, `seek(t)` (scrubbing, fires nothing),
 * `skip(to)` and `fastForward(seconds)` (fire every instant on the way, in order), and `update(delta)` once per
 * frame. Listen with `on(kind, listener)` or iterate `events()`. `using` works.
 */
export class CutscenePlayer {
  /** The compiled cutscene. */
  readonly cutscene: Cutscene;
  /** Playback rate; negative plays backwards. */
  speed: number;
  /** Wrap at the ends instead of finishing. */
  loop: boolean;
  private current: number;
  private running = false;
  private disposed = false;
  private dispatching = false;
  private epoch = 0;
  private readonly listeners = new Map<CutscenePlayerEvent, Set<(event: CutsceneEvent | null) => void>>();
  private waiters: { resolve: (finished: boolean) => void; reject: (reason: unknown) => void; cleanup: () => void }[] =
    [];
  private streams = new Set<(event: CutsceneEvent | null) => void>();
  /** @throws TypeError for an invalid document; RangeError for a bad speed or time. */
  constructor(cutscene: Cutscene | CutsceneDocument | string | unknown, options: CutscenePlayerOptions = {}) {
    this.cutscene = cutscene instanceof Cutscene ? cutscene : new Cutscene(cutscene, { tracks: options.tracks });
    this.speed = options.speed ?? 1;
    if (!Number.isFinite(this.speed))
      throw new RangeError('Cutscene speed must be a finite number; use a negative one to reverse');
    this.loop = options.loop === true;
    this.current = this.clamp(options.time ?? 0);
  }
  /** Current time, seconds, in [0, duration]. */
  get time(): number {
    return this.current;
  }
  /** True between `play()` and a pause, a stop or the end. */
  get playing(): boolean {
    return this.running;
  }
  /** Length of the cutscene, seconds. */
  get duration(): number {
    return this.cutscene.duration;
  }
  /** The state at the current time: `cutscene.evaluate(player.time)`. */
  get state(): CutsceneState {
    return this.cutscene.evaluate(this.current);
  }
  /**
   * Start or resume playing. At the end (or the start, when reversed) it starts over. Resolves `true` when it
   * finishes, `false` when paused or stopped first; rejects with the signal's reason (and pauses) on abort.
   */
  play(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    this.check();
    const signal = options.signal;
    signal?.throwIfAborted();
    if (!this.loop) {
      if (this.speed > 0 && this.current >= this.duration) this.current = 0;
      else if (this.speed < 0 && this.current <= 0) this.current = this.duration;
    }
    this.running = true;
    return new Promise<boolean>((resolve, reject) => {
      const abort = (): void => {
        this.waiters = this.waiters.filter((waiter) => waiter.reject !== reject);
        this.pause();
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push({ resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) });
    });
  }
  /** Stop advancing; `play()` resumes from here. */
  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.settle(false);
  }
  /** Pause and go back to the start (the end when reversed), firing nothing. */
  stop(): void {
    this.pause();
    this.seek(this.speed < 0 ? this.duration : 0);
  }
  /** Flip the direction of play. */
  reverse(): this {
    this.speed = -this.speed;
    return this;
  }
  /** Jump to `time` (clamped) without firing anything: scrubbing. The state is exactly that of playing to it. */
  seek(time: number): this {
    this.check();
    this.current = this.clamp(time);
    this.epoch++;
    return this;
  }
  /**
   * Jump to `time` (default the end, or the start when reversed), firing every instant on the way in order, as if it
   * had played there in one step. Use it for "skip cutscene" so the game still sees every event.
   */
  skip(time: number = this.speed < 0 ? 0 : this.duration): this {
    this.check();
    const to = this.clamp(time);
    const from = this.current;
    this.current = to;
    const epoch = ++this.epoch;
    this.fire(this.cutscene.eventsBetween(from, to), epoch);
    if (
      epoch === this.epoch &&
      this.running &&
      !this.loop &&
      (to === this.duration ? this.speed > 0 : to === 0 && this.speed < 0)
    )
      this.finish();
    return this;
  }
  /** Skip `seconds` ahead in the direction of play, firing what it passes. */
  fastForward(seconds: number): this {
    if (!Number.isFinite(seconds) || seconds < 0)
      throw new RangeError('fastForward needs a finite number of seconds, 0 or more');
    return this.skip(this.current + Math.sign(this.speed || 1) * seconds);
  }
  /**
   * Advance by `delta` seconds of real time times `speed`, firing the instants passed in order; call once per frame.
   * Does nothing while paused.
   * @throws RangeError for a negative or non-finite delta or one that crosses more than 100 loops; MargoError
   * `'state'` when called from a listener, `'disposed'` after dispose.
   */
  update(delta: number): this {
    this.check();
    if (!(delta >= 0) || !Number.isFinite(delta))
      throw new RangeError('Cutscene update delta must be a finite number of seconds, 0 or more');
    if (this.dispatching)
      throw new MargoError(
        'state',
        'CutscenePlayer.update called from a listener; update once per frame from your game loop',
      );
    if (!this.running || delta === 0 || this.speed === 0) return this;
    const end = this.duration,
      epoch = ++this.epoch;
    let rest = delta * this.speed,
      loops = 0;
    while (rest !== 0 && epoch === this.epoch) {
      const from = this.current,
        target = from + rest;
      if (target > end || target < 0) {
        const edge = target > end ? end : 0;
        this.current = edge;
        this.fire(this.cutscene.eventsBetween(from, edge), epoch);
        if (epoch !== this.epoch) return this;
        if (!this.loop) {
          this.finish();
          return this;
        }
        if (++loops > MAX_LOOPS)
          throw new RangeError('Cutscene update crossed more than 100 loops; pass a smaller delta');
        rest = target - edge;
        this.current = edge === end ? 0 : end;
      } else {
        this.current = target;
        this.fire(this.cutscene.eventsBetween(from, target), epoch);
        rest = 0;
      }
    }
    if (
      epoch === this.epoch &&
      !this.loop &&
      (this.current === end ? this.speed > 0 : this.current === 0 && this.speed < 0)
    )
      this.finish();
    return this;
  }
  /** Call `listener` for each instant of `kind` (`'*'`: every kind) as it fires; returns a function that removes it. */
  on(kind: CutscenePlayerEvent, listener: (event: CutsceneEvent) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('Cutscene listener must be a function');
    let set = this.listeners.get(kind);
    if (!set) this.listeners.set(kind, (set = new Set()));
    const entry = listener as (event: CutsceneEvent | null) => void;
    set.add(entry);
    return () => void set.delete(entry);
  }
  /**
   * The instants as they fire, as an async iterator: `for await (const event of player.events({signal}))`. Ends when
   * the player finishes or is disposed, or when the signal aborts.
   */
  async *events(options: { signal?: AbortSignal } = {}): AsyncGenerator<CutsceneEvent, void, undefined> {
    this.check();
    const queue: (CutsceneEvent | null)[] = [];
    let wake: (() => void) | null = null;
    const push = (event: CutsceneEvent | null): void => {
      queue.push(event);
      wake?.();
    };
    const signal = options.signal;
    const abort = (): void => push(null);
    signal?.addEventListener('abort', abort, { once: true });
    this.streams.add(push);
    try {
      while (!signal?.aborted) {
        if (!queue.length) await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
        const event = queue.shift();
        if (event === undefined) continue;
        if (event === null) return;
        yield event;
      }
    } finally {
      this.streams.delete(push);
      signal?.removeEventListener('abort', abort);
    }
  }
  /** Stop playing, settle pending `play()` promises with false and end `events()` iterators; further calls throw. */
  dispose(): void {
    if (this.disposed) return;
    this.pause();
    this.disposed = true;
    for (const push of this.streams) push(null);
    this.listeners.clear();
  }
  /** Same as {@link CutscenePlayer.dispose}, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
  private clamp(time: number): number {
    if (typeof time !== 'number' || !Number.isFinite(time))
      throw new RangeError('Cutscene time must be a finite number of seconds');
    return Math.min(this.duration, Math.max(0, time));
  }
  private check(): void {
    if (this.disposed) throw new MargoError('disposed', 'CutscenePlayer is disposed; create a new CutscenePlayer');
  }
  private fire(events: readonly CutsceneEvent[], epoch: number): void {
    const was = this.dispatching;
    this.dispatching = true;
    try {
      for (const event of events) {
        for (const push of this.streams) push(event);
        for (const kind of [event.kind, '*'] as const)
          for (const listener of [...(this.listeners.get(kind) ?? [])]) {
            listener(event);
            // A listener that seeks or skips takes over; the rest of this step's instants are not fired.
            if (epoch !== this.epoch || this.disposed) return;
          }
      }
    } finally {
      this.dispatching = was;
    }
  }
  private finish(): void {
    this.running = false;
    for (const listener of [...(this.listeners.get('finish') ?? [])]) listener(null);
    for (const push of this.streams) push(null);
    this.settle(true);
  }
  private settle(finished: boolean): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter.cleanup();
      waiter.resolve(finished);
    }
  }
}
