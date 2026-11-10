import { MargoError } from '@margoengine/math/errors';
import type { CutscenePlayer } from './player.js';

/** Range playback direction. Alternate modes reverse each iteration, starting forward or backward. */
export type RangeDirection = 'normal' | 'reverse' | 'alternate' | 'alternateReverse';
/** Playback of one interval of a cutscene. */
export interface RangePlaybackOptions {
  /** Seconds [from,to], with 0 <= from < to <= duration. Default the entire cutscene. */
  range?: readonly [number, number];
  /** Nonnegative count, including fractional counts or Infinity. Default 1. */
  iterationCount?: number;
  /** Default normal. */
  direction?: RangeDirection;
  /** Positive finite rate. Default 1. */
  speed?: number;
}
/** A completed iteration or the end of range playback. */
export interface RangePlaybackEvent {
  /** Count of fully completed iterations. */
  iteration: number;
  /** Direction of the leg just completed. */
  direction: 1 | -1;
}
const checkedRange = (
  player: CutscenePlayer,
  range: readonly [number, number] = [0, player.duration],
): [number, number] => {
  const [from, to] = range;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from >= to || to > player.duration)
    throw new RangeError('Cutscene range must satisfy 0 <= from < to <= duration; pass an interval in seconds');
  return [from, to];
};

/** Advances a borrowed player through a range and fires its instants through skip(). Call update(delta) from your loop. */
export class RangePlayback {
  readonly range: readonly [number, number];
  private readonly count: number;
  private readonly mode: RangeDirection;
  private readonly rate: number;
  private within = 0;
  private turns = 0;
  private running = false;
  private ended = false;
  private disposed = false;
  private updating = false;
  private epoch = 0;
  private pending?: { resolve: (done: boolean) => void; reject: (reason: unknown) => void; cleanup: () => void };
  private readonly listeners = new Map<'iteration' | 'finish', Set<(event: RangePlaybackEvent) => void>>();
  constructor(
    readonly player: CutscenePlayer,
    options: RangePlaybackOptions = {},
  ) {
    this.range = checkedRange(player, options.range);
    this.count = options.iterationCount ?? 1;
    this.mode = options.direction ?? 'normal';
    this.rate = options.speed ?? 1;
    if (!(this.count >= 0) || Number.isNaN(this.count))
      throw new RangeError('Iteration count must be nonnegative or Infinity; pass a number');
    if (!['normal', 'reverse', 'alternate', 'alternateReverse'].includes(this.mode))
      throw new RangeError('Unknown range direction; use normal, reverse, alternate or alternateReverse');
    if (!(this.rate > 0) || !Number.isFinite(this.rate))
      throw new RangeError('Range speed must be finite and positive; use direction to reverse');
  }
  /** True while this controller advances the borrowed player. */
  get playing(): boolean {
    return this.running;
  }
  /** Fully completed iterations. */
  get iteration(): number {
    return this.turns;
  }
  private direction(): 1 | -1 {
    const reversed = this.mode === 'reverse' || this.mode === 'alternateReverse';
    const alternating = this.mode === 'alternate' || this.mode === 'alternateReverse';
    return reversed !== (alternating && this.turns % 2 === 1) ? -1 : 1;
  }
  private at(distance: number): number {
    return this.direction() === 1 ? this.range[0] + distance : this.range[1] - distance;
  }
  /** Starts or resumes. Resolves true at the final endpoint, false on pause; abort rejects and pauses. */
  play({ signal }: { signal?: AbortSignal } = {}): Promise<boolean> {
    if (this.disposed) throw new MargoError('disposed', 'Range playback is disposed; create a new controller');
    signal?.throwIfAborted();
    this.pause();
    this.player.pause();
    if (this.ended) {
      this.within = 0;
      this.turns = 0;
      this.ended = false;
    }
    this.player.seek(this.at(this.within));
    if (this.count === 0) {
      this.ended = true;
      return Promise.resolve(true);
    }
    this.running = true;
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.running = false;
        this.pending?.cleanup();
        this.pending = undefined;
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) };
    });
  }
  /** Stops at the current time, retaining progress for play(). */
  pause(): void {
    this.epoch++;
    this.running = false;
    const pending = this.pending;
    this.pending = undefined;
    pending?.cleanup();
    pending?.resolve(false);
  }
  /** Pauses and resets the interval to its starting endpoint, with no instants fired. */
  stop(): void {
    this.pause();
    this.within = 0;
    this.turns = 0;
    this.ended = false;
    this.player.seek(this.at(0));
  }
  /** Listen for each whole iteration or final completion. Returns an unsubscribe function. */
  on(kind: 'iteration' | 'finish', listener: (event: RangePlaybackEvent) => void): () => void {
    if (!['iteration', 'finish'].includes(kind)) throw new RangeError('Unknown range event; use iteration or finish');
    const set = this.listeners.get(kind) ?? new Set();
    this.listeners.set(kind, set);
    set.add(listener);
    return () => void set.delete(listener);
  }
  private emit(kind: 'iteration' | 'finish', direction: 1 | -1): void {
    for (const fn of [...(this.listeners.get(kind) ?? [])]) fn({ iteration: this.turns, direction });
  }
  /** Advances through all crossed legs in order. At most 1000 boundaries per call; split larger deltas. */
  update(delta: number): void {
    if (this.disposed) throw new MargoError('disposed', 'Range playback is disposed; create a new controller');
    if (!(delta >= 0) || !Number.isFinite(delta))
      throw new RangeError('Range delta must be finite and nonnegative; pass seconds');
    if (this.updating)
      throw new MargoError('state', 'Range update is already running; update once per frame outside listeners');
    if (!this.running || delta === 0) return;
    const span = this.range[1] - this.range[0],
      total = span * this.count;
    const epoch = this.epoch;
    let rest = Math.min(delta * this.rate, total - this.turns * span - this.within);
    if (!Number.isFinite(rest) || Math.floor((this.within + rest) / span) > 1000)
      throw new RangeError('Range update crosses more than 1000 boundaries; pass a smaller delta');
    this.updating = true;
    try {
      while (this.running && rest > 0) {
        const direction = this.direction(),
          limit = Math.min(span, total - this.turns * span),
          step = Math.min(rest, limit - this.within);
        this.within += step;
        rest -= step;
        const to = this.at(this.within);
        this.player.skip(to);
        if (!this.running || this.epoch !== epoch) return;
        if (this.player.time !== to) {
          this.pause();
          return;
        }
        if (this.within === limit) {
          const complete = limit === span;
          if (complete) this.turns++;
          if (this.turns * span + (complete ? 0 : this.within) >= total) {
            this.running = false;
            this.ended = true;
            const pending = this.pending;
            this.pending = undefined;
            pending?.cleanup();
            pending?.resolve(true);
            if (complete) this.emit('iteration', direction);
            this.emit('finish', direction);
            return;
          }
          this.within = 0;
          this.emit('iteration', direction);
          if (!this.running || this.epoch !== epoch) return;
          this.player.seek(this.at(0));
        }
      }
    } finally {
      this.updating = false;
    }
  }
  /** Pauses and removes listeners; the borrowed player remains usable. */
  dispose(): void {
    if (this.disposed) return;
    this.pause();
    this.disposed = true;
    this.listeners.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Scroll binding, using page or element scroll offsets. */
export interface ScrollPlaybackOptions {
  /** Default window; an element can be used for an embedded scroll pane. */
  source?: Window | HTMLElement;
  /** Physical axis, default y. */
  axis?: 'x' | 'y';
  /** Scroll offset at range start, pixels. Default 0. */
  start?: number;
  /** Offset at range end, pixels. Default the source's current maximum scroll offset. */
  end?: number;
  /** Timeline seconds. Default [0,duration]. */
  range?: readonly [number, number];
  /** Exponential scrub time constant in seconds. Default 0: immediate. */
  scrub?: number;
  /** Bind scroll/resize events and animate smoothing. Default true; false uses update(delta) only. */
  automatic?: boolean;
  /** Dispose on abort. */
  signal?: AbortSignal;
}

/** Seeks a borrowed cutscene player from scroll, firing no timeline instants. */
export class ScrollPlayback {
  private readonly range: readonly [number, number];
  private readonly source: Window | HTMLElement;
  private readonly view: Window;
  private readonly scrub: number;
  private readonly abort = new AbortController();
  private frame = 0;
  private stamp?: number;
  private disposed = false;
  constructor(
    readonly player: CutscenePlayer,
    private readonly options: ScrollPlaybackOptions = {},
  ) {
    options.signal?.throwIfAborted();
    this.range = checkedRange(player, options.range);
    this.source = options.source ?? window;
    this.view = 'ownerDocument' in this.source ? this.source.ownerDocument.defaultView! : this.source;
    this.scrub = options.scrub ?? 0;
    if (!(this.scrub >= 0) || !Number.isFinite(this.scrub))
      throw new RangeError('Scroll scrub must be finite and nonnegative; pass seconds');
    if (options.axis !== undefined && options.axis !== 'x' && options.axis !== 'y')
      throw new RangeError('Scroll axis must be x or y; choose a physical axis');
    if (
      !Number.isFinite(options.start ?? 0) ||
      !Number.isFinite(options.end ?? 0) ||
      (options.end !== undefined && options.end <= (options.start ?? 0))
    )
      throw new RangeError('Scroll offsets must be finite with end above start; pass pixel offsets');
    player.pause();
    if (options.automatic !== false) {
      this.source.addEventListener('scroll', this.refresh, { passive: true, signal: this.abort.signal });
      this.view.addEventListener('resize', this.refresh, { signal: this.abort.signal });
    }
    options.signal?.addEventListener('abort', this.dispose, { once: true });
    this.refresh();
  }
  private target(): number {
    const x = this.options.axis === 'x',
      element = 'ownerDocument' in this.source ? this.source : this.source.document.scrollingElement!;
    const offset = x ? element.scrollLeft : element.scrollTop;
    const start = this.options.start ?? 0,
      end =
        this.options.end ??
        (x ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight);
    const progress = end > start ? Math.max(0, Math.min(1, (offset - start) / (end - start))) : 0;
    return this.range[0] + (this.range[1] - this.range[0]) * progress;
  }
  /** Refreshes scroll geometry and schedules smoothing. Call after changing content size without a resize/scroll event. */
  readonly refresh = (): void => {
    if (this.disposed) return;
    if (this.scrub === 0) this.player.seek(this.target());
    else if (this.options.automatic !== false && !this.frame) {
      this.stamp = undefined;
      this.frame = this.view.requestAnimationFrame(this.tick);
    }
  };
  private readonly tick = (stamp: number): void => {
    this.frame = 0;
    this.update(this.stamp === undefined ? 0 : (stamp - this.stamp) / 1000);
    this.stamp = stamp;
    const target = this.target();
    if (Math.abs(this.player.time - target) > 1e-7) this.frame = this.view.requestAnimationFrame(this.tick);
    else this.player.seek(target);
  };
  /** Advances smoothing from current scroll geometry; automatic false lets an app use its own clock. */
  update(delta: number): void {
    if (this.disposed) throw new MargoError('disposed', 'Scroll playback is disposed; create a new binding');
    if (!(delta >= 0) || !Number.isFinite(delta))
      throw new RangeError('Scroll delta must be finite and nonnegative; pass seconds');
    const target = this.target();
    this.player.seek(this.scrub === 0 ? target : target + (this.player.time - target) * Math.exp(-delta / this.scrub));
  }
  /** Cancels the frame and event listeners without disposing the player. */
  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    if (this.frame) this.view.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.options.signal?.removeEventListener('abort', this.dispose);
  };
  [Symbol.dispose](): void {
    this.dispose();
  }
}
