// Clock synchronisation (Cristian's method over a window): each pong gives the server's tick at the moment it
// answered; the sample with the smallest round trip is the most trustworthy, and half its round trip is the one-way
// delay. The spread of round trips in the window is the jitter the client must absorb.

/** One clock sample. */
interface Sample {
  rtt: number;
  receivedAt: number;
  tick: number;
}

/**
 * Estimates the server's tick from ping and pong times. Add each pong with {@link ClockSync.add}; read
 * {@link ClockSync.serverTick} for the server's fractional tick at any local time.
 */
export class ClockSync {
  private readonly samples: Sample[] = [];
  /**
   * @param tickMs Milliseconds per server tick.
   * @param window How many recent samples to keep (default 8).
   * @throws RangeError for a non-positive `tickMs` or a window under 1.
   */
  constructor(
    readonly tickMs: number,
    readonly window = 8,
  ) {
    if (!(tickMs > 0) || !Number.isFinite(tickMs)) throw new RangeError(`ClockSync tickMs is ${tickMs}; pass ms > 0`);
    if (!Number.isInteger(window) || window < 1)
      throw new RangeError(`ClockSync window is ${window}; pass an integer of 1 or more`);
  }
  /** Whether at least one sample arrived. */
  get synced(): boolean {
    return this.samples.length > 0;
  }
  /**
   * Adds a pong: the local time its ping left, the local time it arrived, the server's last tick and how far (0 to
   * 1) the server was into the next one when it answered. Samples with a negative round trip are ignored.
   */
  add(sentAt: number, receivedAt: number, tick: number, fraction: number): void {
    const rtt = receivedAt - sentAt;
    if (!(rtt >= 0) || !Number.isFinite(rtt) || !Number.isFinite(tick) || !Number.isFinite(fraction)) return;
    this.samples.push({ rtt, receivedAt, tick: tick + Math.min(Math.max(fraction, 0), 1) });
    if (this.samples.length > this.window) this.samples.shift();
  }
  private best(): Sample | undefined {
    let best: Sample | undefined;
    for (const s of this.samples) if (!best || s.rtt < best.rtt) best = s;
    return best;
  }
  /** The smallest round trip in the window, in milliseconds (0 before any sample). */
  get rtt(): number {
    return this.best()?.rtt ?? 0;
  }
  /** Half the spread of round trips in the window, in milliseconds: how much one-way delay varies. */
  get jitter(): number {
    if (!this.samples.length) return 0;
    let low = Infinity,
      high = -Infinity;
    for (const s of this.samples) {
      low = Math.min(low, s.rtt);
      high = Math.max(high, s.rtt);
    }
    return (high - low) / 2;
  }
  /** The server's fractional tick at local time `now` (NaN before any sample). */
  serverTick(now: number): number {
    const s = this.best();
    if (!s) return Number.NaN;
    return s.tick + (s.rtt / 2 + (now - s.receivedAt)) / this.tickMs;
  }
}
