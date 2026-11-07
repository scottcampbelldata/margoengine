// Adaptive render delay. Playout adaptation for packet audio (Ramjee et al. 1994; Moon, Kurose and Towsley 1998) set
// per snapshot stream: log what recent arrivals needed, play at a percentile of that, and follow a delay spike
// instead of learning from it. Audio moves its playout point in the silence between talkspurts; a game has no
// silence, so here the view's clock runs a little slow or fast until it reaches the new delay.

/** Options of {@link AdaptiveDelay}. All times are seconds. */
export interface AdaptiveDelayOptions {
  /** Share of recent arrivals the delay must cover, 0.5 to 1 (default 0.99). */
  quantile?: number;
  /** Arrivals remembered, an integer 16 to 65536 (default 256, about 13 s at 20 snapshots a second). */
  window?: number;
  /** Delay used while fewer than 8 arrivals are known, and the floor until then (default 0.1). */
  initial?: number;
  /** Smallest delay (default 0). */
  min?: number;
  /** Largest delay (default 1). */
  max?: number;
  /** Added to the measured delay (default 0). */
  margin?: number;
  /** How much slower than real time the view may run to gain delay, 0 to 0.9 (default 0.25). */
  slowdown?: number;
  /** How much faster than real time the view may run to shed delay, 0 to 1 (default 0.05). */
  speedup?: number;
  /** An arrival needing over this many times the delay starts a spike, above 1 (default 4). */
  spikeHead?: number;
  /** A spike ends at an arrival needing no more than this many times the delay before it, 1 or more (default 2). */
  spikeTail?: number;
}

/** Arrivals needed before the measured delay replaces `initial` as the floor. */
const WARM = 8;

const range = (name: string, value: number, low: number, high: number): number => {
  if (!(value >= low && value <= high))
    throw new RangeError(`AdaptiveDelay ${name} is ${value}; pass a number from ${low} to ${high}`);
  return value;
};

/**
 * Picks how far behind the newest snapshot to draw from what the link actually does, and runs the view's clock. Feed
 * it every snapshot with {@link AdaptiveDelay.observe}, then sample a snapshot buffer at
 * {@link AdaptiveDelay.renderTime} each frame. The two clocks need no synchronisation: only differences of `received
 * - sent` are used, and the smallest of them stands for the link's fixed delay and the clock offset.
 *
 * What is measured is the delay each arrival would have needed. For the view to have something to blend toward just
 * before a snapshot landed, it must not have passed the newest snapshot then held. That one number holds the send
 * interval, the jitter and any lost snapshots, so a clean link settles on exactly one send interval.
 *
 * @example
 * ```ts
 * import { SnapshotBuffer, createSnapshot } from '@margoengine/net';
 * import { AdaptiveDelay } from '@margoengine/net/delay';
 *
 * const buffer = new SnapshotBuffer(),
 *   delay = new AdaptiveDelay(),
 *   pose = createSnapshot();
 * function onSnapshot(serverTime: number, position: number[]) {
 *   buffer.push(serverTime, position);
 *   delay.observe(serverTime, performance.now() / 1000);
 * }
 * function onFrame() {
 *   const time = delay.renderTime(performance.now() / 1000);
 *   if (!Number.isNaN(time)) buffer.sample(time, pose);
 * }
 * ```
 */
export class AdaptiveDelay {
  /** Share of recent arrivals the delay covers. */
  readonly quantile: number;
  /** Arrivals remembered. */
  readonly window: number;
  /** See {@link AdaptiveDelayOptions.initial}. */
  readonly initial: number;
  /** Smallest delay in seconds. */
  readonly min: number;
  /** Largest delay in seconds. */
  readonly max: number;
  /** See {@link AdaptiveDelayOptions.margin}. */
  readonly margin: number;
  /** See {@link AdaptiveDelayOptions.slowdown}. */
  readonly slowdown: number;
  /** See {@link AdaptiveDelayOptions.speedup}. */
  readonly speedup: number;
  /** See {@link AdaptiveDelayOptions.spikeHead}. */
  readonly spikeHead: number;
  /** See {@link AdaptiveDelayOptions.spikeTail}. */
  readonly spikeTail: number;
  /** Whether a delay spike is being followed. */
  spiking = false;
  /** The delay the view is heading for, in seconds. */
  target: number;
  // Every arrival's transit, oldest first from `transitHead`: the smallest is the link's floor.
  private readonly transits: Float64Array;
  private transitHead = 0;
  private transitCount = 0;
  private floor = Number.POSITIVE_INFINITY;
  // Recent gaps (arrival minus the newest snapshot then held) in arrival order, and the same values sorted.
  private readonly gaps: Float64Array;
  private readonly sorted: Float64Array;
  private gapHead = 0;
  private gapCount = 0;
  private newest = Number.NEGATIVE_INFINITY;
  private spikeFrom = 0;
  private spikeLength = 0;
  private rendered = Number.NaN;
  private lastNow = Number.NaN;

  /** @throws RangeError for an option out of range, or `min` above `max`. */
  constructor(options: AdaptiveDelayOptions = {}) {
    const {
      quantile = 0.99,
      window = 256,
      initial = 0.1,
      min = 0,
      max = 1,
      margin = 0,
      slowdown = 0.25,
      speedup = 0.05,
      spikeHead = 4,
      spikeTail = 2,
    } = options;
    this.quantile = range('quantile', quantile, 0.5, 1);
    if (!Number.isInteger(window)) throw new RangeError(`AdaptiveDelay window is ${window}; pass an integer`);
    this.window = range('window', window, 16, 65536);
    this.max = range('max', max, 0, 60);
    this.min = range('min', min, 0, this.max);
    this.initial = range('initial', initial, 0, 60);
    this.margin = range('margin', margin, 0, 60);
    this.slowdown = range('slowdown', slowdown, 0, 0.9);
    this.speedup = range('speedup', speedup, 0, 1);
    this.spikeTail = range('spikeTail', spikeTail, 1, 1e6);
    this.spikeHead = range('spikeHead', spikeHead, 1 + Number.EPSILON, 1e6);
    this.transits = new Float64Array(window);
    this.gaps = new Float64Array(window);
    this.sorted = new Float64Array(window);
    this.target = this.clamp(initial);
  }

  /** The smallest `received - sent` remembered: the link's fixed delay plus the clocks' offset (NaN before any). */
  get offset(): number {
    return this.transitCount ? this.floor : Number.NaN;
  }

  /** The delay the view runs at now in seconds: {@link AdaptiveDelay.target} until the first `renderTime`. */
  get delay(): number {
    return Number.isNaN(this.rendered) ? this.target : this.lastNow - this.floor - this.rendered;
  }

  /**
   * Records one snapshot: the sender's time on it and the local time it arrived, in seconds.
   * @returns Whether it was newer than every snapshot before it; an older one only teaches the link's floor.
   * @throws RangeError for a time that is not finite.
   */
  observe(sent: number, received: number): boolean {
    if (!Number.isFinite(sent) || !Number.isFinite(received))
      throw new RangeError(`AdaptiveDelay.observe got ${sent}, ${received}; pass finite times in seconds`);
    this.addTransit(received - sent);
    if (sent <= this.newest) return false;
    const first = this.newest === Number.NEGATIVE_INFINITY,
      gap = received - this.newest;
    this.newest = sent;
    if (first) return true;
    const need = gap - this.floor;
    if (this.spiking) {
      this.spikeLength++;
      if (need <= this.spikeTail * this.spikeFrom) this.spiking = false;
      else if (this.spikeLength > this.window >> 2) {
        // Too long for a spike: the link itself moved. Measure it afresh.
        this.spiking = false;
        this.gapCount = this.gapHead = this.transitCount = this.transitHead = 0;
        this.addTransit(received - sent);
      } else {
        this.target = this.clamp(need + this.margin);
        return true;
      }
    } else if (this.gapCount >= WARM && need > this.spikeHead * this.target) {
      this.spiking = true;
      this.spikeFrom = this.target;
      this.spikeLength = 0;
      this.target = this.clamp(need + this.margin);
      return true;
    }
    this.addGap(gap);
    const measured = this.sorted[Math.min(this.gapCount - 1, Math.ceil(this.quantile * this.gapCount) - 1)] - this.floor;
    this.target = this.clamp((this.gapCount < WARM ? Math.max(this.initial, measured) : measured) + this.margin);
    return true;
  }

  /**
   * The sender's time to draw at local time `now` in seconds, or NaN before the first snapshot. It never goes back and
   * only moves off real time by `slowdown` or `speedup`, so a change of delay shows as slightly slow or fast motion;
   * a view further behind than `max` jumps forward.
   * @throws RangeError for a time that is not finite.
   */
  renderTime(now: number): number {
    if (!Number.isFinite(now)) throw new RangeError(`AdaptiveDelay.renderTime got ${now}; pass a finite time in seconds`);
    if (!this.transitCount) return Number.NaN;
    const wanted = now - this.floor - this.target;
    if (Number.isNaN(this.rendered)) {
      this.rendered = wanted;
      this.lastNow = now;
      return wanted;
    }
    const elapsed = Math.max(0, now - this.lastNow),
      error = wanted - this.rendered - elapsed;
    this.lastNow = Math.max(this.lastNow, now);
    if (error > this.max) this.rendered = wanted;
    else this.rendered += elapsed + Math.min(elapsed * this.speedup, Math.max(-elapsed * this.slowdown, error));
    return this.rendered;
  }

  /** Forgets the link and the view's clock, as after a reconnect. */
  reset(): void {
    this.gapCount = this.gapHead = this.transitCount = this.transitHead = 0;
    this.floor = Number.POSITIVE_INFINITY;
    this.newest = Number.NEGATIVE_INFINITY;
    this.rendered = this.lastNow = Number.NaN;
    this.spiking = false;
    this.target = this.clamp(this.initial);
  }

  private clamp(value: number): number {
    return Math.min(this.max, Math.max(this.min, value));
  }

  private addTransit(value: number): void {
    const list = this.transits,
      size = this.window;
    if (this.transitCount < size) {
      list[(this.transitHead + this.transitCount++) % size] = value;
      this.floor = this.transitCount === 1 ? value : Math.min(this.floor, value);
      return;
    }
    const gone = list[this.transitHead];
    list[this.transitHead] = value;
    this.transitHead = (this.transitHead + 1) % size;
    if (value <= this.floor) this.floor = value;
    else if (gone === this.floor) {
      let low = Number.POSITIVE_INFINITY;
      for (let i = 0; i < size; i++) if (list[i] < low) low = list[i];
      this.floor = low;
    }
  }

  private addGap(value: number): void {
    const sorted = this.sorted,
      size = this.window;
    if (this.gapCount === size) {
      const gone = this.gaps[this.gapHead],
        at = lowerBound(sorted, size, gone);
      sorted.copyWithin(at, at + 1, size);
      this.gapCount--;
      this.gaps[this.gapHead] = value;
      this.gapHead = (this.gapHead + 1) % size;
    } else this.gaps[(this.gapHead + this.gapCount) % size] = value;
    const at = lowerBound(sorted, this.gapCount, value);
    sorted.copyWithin(at + 1, at, this.gapCount);
    sorted[at] = value;
    this.gapCount++;
  }
}

/** The first index of the `count` sorted values holding `value` or more. */
const lowerBound = (sorted: Float64Array, count: number, value: number): number => {
  let low = 0,
    high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
};
