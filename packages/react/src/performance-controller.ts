import { MargoError } from '@margoengine/math/errors';

/** A measured window, published once per averaging interval, with a quality factor in [0, 1]. */
export interface PerformanceSnapshot {
  readonly fps: number;
  readonly refreshrate: number;
  readonly factor: number;
  readonly frames: readonly number[];
  readonly averages: readonly number[];
  readonly flips: number;
  readonly fallback: boolean;
}
/** Notifications after averaged quality decisions, shared by the monitor and descendant hooks. */
export interface PerformanceCallbacks {
  onIncline?: (api: PerformanceSnapshot) => void;
  onDecline?: (api: PerformanceSnapshot) => void;
  onChange?: (api: PerformanceSnapshot) => void;
  onFallback?: (api: PerformanceSnapshot) => void;
}
/** Averaging, hysteresis and fallback configuration for the performance controller. */
export interface PerformanceOptions extends PerformanceCallbacks {
  /** Averaging interval in milliseconds. Default 250. */
  ms?: number;
  /** Windows per decision. Default 10. */
  iterations?: number;
  /** Fraction of windows outside a bound required for a decision. Default 0.75. */
  threshold?: number;
  /** Initial quality, default 1. */
  factor?: number;
  /** Quality step, default 0.1. */
  step?: number;
  /** Allowed direction reversals before fallback. Default Infinity. */
  flipflops?: number;
  /** Stable quality after excessive reversals, default 0. */
  fallbackFactor?: number;
  /** FPS deadband, default [50, 57] or [50, 90] above a 90 Hz observed window average. */
  bounds?: (refreshrate: number) => readonly [number, number];
}
const defaults = (rate: number): readonly [number, number] => [50, rate > 90 ? 90 : 57];
/** Deterministic frame-time controller. Samples are measured elapsed milliseconds, not instantaneous reciprocal FPS. */
export class PerformanceController {
  private readonly settings;
  private elapsed = 0;
  private count = 0;
  private frames: number[] = [];
  private averages: number[] = [];
  private direction = 0;
  private closed = false;
  private current: PerformanceSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly callbacks = new Set<PerformanceCallbacks>();
  constructor(private readonly options: PerformanceOptions = {}) {
    const { ms = 250, iterations = 10, threshold = 0.75, factor = 1, step = 0.1, flipflops = Infinity, fallbackFactor = 0 } = options;
    if (!(Number.isFinite(ms) && ms > 0 && Number.isInteger(iterations) && iterations > 0 &&
      Number.isFinite(threshold) && threshold > 0 && threshold <= 1 && Number.isFinite(step) && step > 0 && step <= 1 &&
      Number.isFinite(factor) && factor >= 0 && factor <= 1 && Number.isFinite(fallbackFactor) && fallbackFactor >= 0 && fallbackFactor <= 1 &&
      (flipflops === Infinity || Number.isInteger(flipflops) && flipflops >= 0)))
      throw new RangeError('Invalid performance options; use positive ms/iterations, factors in [0,1] and a nonnegative flipflops count.');
    this.settings = { ms, iterations, threshold, factor, step, flipflops, fallbackFactor };
    this.current = Object.freeze({ fps: 0, refreshrate: 0, factor, frames: Object.freeze([]), averages: Object.freeze([]), flips: 0, fallback: false });
  }
  get state(): PerformanceSnapshot { return this.current; }
  subscribe(listener: () => void): () => void { this.live(); this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  observe(callbacks: PerformanceCallbacks): () => void { this.live(); this.callbacks.add(callbacks); return () => { this.callbacks.delete(callbacks); }; }
  /** Discard incomplete windows after visibility changes or demand-mode idle time; keep the selected quality. */
  clear(): void { this.elapsed = this.count = 0; this.frames = []; this.averages = []; }
  reset(): void {
    this.live(); this.clear(); this.direction = 0;
    this.current = Object.freeze({ ...this.current, factor: this.settings.factor, fps: 0, refreshrate: 0, flips: 0, fallback: false, frames: Object.freeze([]), averages: Object.freeze([]) });
    this.publish();
  }
  /** Positive measured milliseconds. Invalid/zero samples are ignored; active long frames still lower quality. */
  sample(milliseconds: number): void {
    this.live();
    if (!Number.isFinite(milliseconds) || milliseconds <= 0 || this.current.fallback) return;
    this.elapsed += milliseconds; this.count++;
    if (this.frames.length < 4096) this.frames.push(milliseconds);
    if (this.elapsed < this.settings.ms) return;
    const fps = Math.min(Number.MAX_VALUE, this.count / this.elapsed * 1000), refreshrate = Math.max(fps, this.current.refreshrate);
    this.averages.push(fps);
    let { factor, flips } = this.current;
    let fallback: boolean = false;
    let event: 'onIncline' | 'onDecline' | undefined;
    if (this.averages.length >= this.settings.iterations) {
      const [lower, upper] = (this.options.bounds ?? defaults)(refreshrate);
      if (![lower, upper].every(Number.isFinite) || lower <= 0 || upper <= lower)
        throw new RangeError('Performance bounds must be finite positive FPS with lower < upper.');
      const above = this.averages.filter(value => value > upper).length / this.averages.length;
      const below = this.averages.filter(value => value < lower).length / this.averages.length;
      const direction = below >= this.settings.threshold ? -1 : above >= this.settings.threshold ? 1 : 0;
      if (direction) {
        if (this.direction && direction !== this.direction) flips++;
        this.direction = direction;
        fallback = flips > this.settings.flipflops;
        factor = fallback ? this.settings.fallbackFactor : Math.max(0, Math.min(1, factor + direction * this.settings.step));
        event = direction > 0 ? 'onIncline' : 'onDecline';
      }
    }
    const changed = factor !== this.current.factor;
    this.current = Object.freeze({ fps, refreshrate, factor, flips, fallback, frames: Object.freeze(this.frames), averages: Object.freeze([...this.averages]) });
    this.elapsed = this.count = 0; this.frames = [];
    if (this.averages.length >= this.settings.iterations) this.averages = [];
    this.publish();
    for (const callbacks of [this.options, ...this.callbacks]) {
      if (fallback) callbacks.onFallback?.(this.current);
      else if (event) callbacks[event]?.(this.current);
      if (changed) callbacks.onChange?.(this.current);
    }
  }
  private publish(): void { for (const listener of this.listeners) listener(); }
  private live(): void { if (this.closed) throw new MargoError('disposed', 'PerformanceController is disposed; create a new controller. See https://margoengine.com/errors#disposed'); }
  dispose(): void { if (this.closed) return; this.closed = true; this.clear(); this.listeners.clear(); this.callbacks.clear(); }
  [Symbol.dispose](): void { this.dispose(); }
}
