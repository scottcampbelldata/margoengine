/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { Stats } from './index.js';
import type { GPUMemory } from './report.js';

/** A number that kept growing. */
export interface LeakAlert {
  /** `'gpu bytes'`, `'buffers'`, `'textures'`, `'label <name> bytes'`, `'label <name> count'`, or a `watch` name. */
  name: string;
  /** The lowest value in the first quarter of the window. */
  from: number;
  /** The lowest value in the last quarter of the window. */
  to: number;
  /** Growth of that low point per minute. */
  perMinute: number;
  /** `performance.now()` of the sample that raised it. */
  at: number;
}
/** What {@link LeakWatch.toJSON} returns; safe for `JSON.stringify`. */
export interface LeakWatchReport {
  samples: number;
  /** Names growing now. */
  leaking: string[];
  /** Every alert raised, newest last. */
  alerts: LeakAlert[];
}
/** Options for {@link LeakWatch}. */
export interface LeakWatchOptions {
  /** Time between samples, or 0 to call `sample()` yourself. Default 5000. */
  intervalMilliseconds?: number;
  /** Samples judged together, 8..4096, a multiple of 4. Default 48 (four minutes at the default interval). */
  window?: number;
  /** Bytes a low point must grow by to alert. Default 1048576. */
  minBytes?: number;
  /** Objects a low point must grow by to alert. Default 16. */
  minCount?: number;
  /** Numbers followed at most, the labels of a {@link GPUMemory} included. Default 64. */
  maxSeries?: number;
  /** Called for each alert. Default `console.warn`; null for none. */
  warn?: ((alert: LeakAlert) => void) | null;
}

type Series = { values: Float64Array; count: number; min: number; read?: () => number; leaking: boolean };
const warnConsole = (alert: LeakAlert): void =>
  console.warn(
    `Possible leak: ${alert.name} keeps growing, ${alert.from} to ${alert.to} (${Math.round(alert.perMinute)} per minute)`,
  );

/**
 * Warns when GPU memory or a resource count keeps growing. Each window of samples is cut into quarters and the lowest
 * value of each is taken: a leak raises all of them, while a load, a level change or a pool that fills and empties does
 * not, however high it peaks. Alerts fire once and can fire again after the growth stops.
 */
export class LeakWatch {
  /** Samples taken. */
  samples = 0;
  private readonly series = new Map<string, Series>();
  private readonly alerts: LeakAlert[] = [];
  private readonly listeners = new Set<(alert: LeakAlert) => void>();
  private readonly clock: Float64Array;
  private readonly size: number;
  private readonly minBytes: number;
  private readonly minCount: number;
  private readonly maxSeries: number;
  private readonly warn: ((alert: LeakAlert) => void) | null;
  private readonly memory?: GPUMemory;
  private readonly interval?: ReturnType<typeof setInterval>;
  private timer?: ReturnType<typeof setInterval>;
  private row?: HTMLElement;
  private disposed = false;

  /** Follows a {@link GPUMemory}: its totals and each of its labels. */
  static attach(memory: GPUMemory, options: LeakWatchOptions = {}): LeakWatch {
    return new LeakWatch(options, memory);
  }
  constructor(
    {
      intervalMilliseconds = 5000,
      window = 48,
      minBytes = 1048576,
      minCount = 16,
      maxSeries = 64,
      warn = warnConsole,
    }: LeakWatchOptions = {},
    memory?: GPUMemory,
  ) {
    if (!Number.isFinite(intervalMilliseconds) || intervalMilliseconds < 0)
      throw new RangeError('intervalMilliseconds must be 0 or above');
    if (!Number.isInteger(window) || window < 8 || window > 4096 || window % 4)
      throw new RangeError('window must be 8..4096 and a multiple of 4');
    if (!(minBytes > 0) || !(minCount > 0)) throw new RangeError('minBytes and minCount must be above 0');
    if (!Number.isInteger(maxSeries) || maxSeries < 1) throw new RangeError('maxSeries must be 1 or above');
    this.size = window;
    this.clock = new Float64Array(window);
    this.minBytes = minBytes;
    this.minCount = minCount;
    this.maxSeries = maxSeries;
    this.warn = warn;
    this.memory = memory;
    if (intervalMilliseconds) this.interval = setInterval(() => this.sample(), intervalMilliseconds);
  }

  /** Follows any number, such as a mesh count, until `dispose()`. `min` is how far its low point must grow. */
  watch(name: string, read: () => number, { min = this.minCount }: { min?: number } = {}): this {
    if (this.disposed) throw new MargoError('disposed', 'LeakWatch is disposed; create a new one to watch a number.');
    if (!name || typeof read !== 'function') throw new TypeError('watch needs a name and a function; pass both.');
    if (!(min > 0)) throw new RangeError('min must be above 0');
    if (this.series.has(name)) throw new TypeError(`Already watching ${name}; pick another name.`);
    const series = this.add(name, min);
    if (!series)
      throw new RangeError(`maxSeries is reached, so ${name} cannot be followed; raise it or watch fewer labels.`);
    series.read = read;
    return this;
  }
  private add(name: string, min: number): Series | undefined {
    if (this.series.size >= this.maxSeries) return;
    const series = { values: new Float64Array(this.size), count: 0, min, leaking: false };
    this.series.set(name, series);
    return series;
  }
  private record(name: string, value: number, min: number): void {
    const series = this.series.get(name) ?? this.add(name, min);
    if (series) this.push(series, value);
  }
  private push(series: Series, value: number): void {
    series.values[this.samples % this.size] = value;
    series.count++;
  }

  /** Reads every number once and returns the alerts this raised. */
  sample(now: number = performance.now()): LeakAlert[] {
    if (this.disposed) throw new MargoError('disposed', 'LeakWatch is disposed; create a new one to take samples.');
    this.clock[this.samples % this.size] = now;
    if (this.memory) {
      const { bytes, buffers, textures, labels } = this.memory.toJSON();
      this.record('gpu bytes', bytes, this.minBytes);
      this.record('buffers', buffers.count, this.minCount);
      this.record('textures', textures.count, this.minCount);
      for (const label in labels) {
        this.record(`label ${label} bytes`, labels[label].bytes, this.minBytes);
        this.record(`label ${label} count`, labels[label].count, this.minCount);
      }
    }
    for (const series of this.series.values())
      if (series.read) {
        const value = series.read();
        if (!Number.isFinite(value)) throw new RangeError('A watched number must be finite; make its read function return one.');
        this.push(series, value);
      }
    this.samples++;
    const raised: LeakAlert[] = [];
    for (const [name, series] of this.series) {
      const alert = this.judge(name, series, now);
      if (alert && !series.leaking) raised.push(alert);
      series.leaking = !!alert;
    }
    for (const alert of raised) {
      this.alerts.push(alert);
      if (this.alerts.length > 256) this.alerts.shift();
      this.warn?.(alert);
      this.listeners.forEach((listener) => listener(alert));
    }
    return raised;
  }
  private judge(name: string, series: Series, now: number): LeakAlert | undefined {
    const { size } = this;
    if (series.count < size) return;
    // Oldest sample first: the ring's next write position.
    const start = this.samples % size,
      quarter = size / 4,
      floors = [Infinity, Infinity, Infinity, Infinity];
    for (let i = 0; i < size; i++) {
      const part = (i / quarter) | 0;
      floors[part] = Math.min(floors[part], series.values[(start + i) % size]);
    }
    const [from, second, third, to] = floors;
    if (!(from < second && second < third && third < to) || to - from < series.min) return;
    // The quarters' low points lie about three quarters of the window apart.
    const elapsed = ((now - this.clock[start]) * 3) / 4;
    return { name, from, to, perMinute: elapsed > 0 ? ((to - from) / elapsed) * 60000 : 0, at: now };
  }

  /** Names growing now. */
  get leaking(): string[] {
    return [...this.series].filter(([, series]) => series.leaking).map(([name]) => name);
  }
  /** Calls `listener` for each alert; returns its remover. */
  onLeak(listener: (alert: LeakAlert) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** A copy of the state. */
  toJSON(): LeakWatchReport {
    return { samples: this.samples, leaking: this.leaking, alerts: this.alerts.map((alert) => ({ ...alert })) };
  }
  /** Shows what is growing in a row of the Stats panel, refreshed twice a second until `dispose()`. */
  view(stats: Stats): this {
    if (this.row) return this;
    const row = (this.row = stats.element.ownerDocument.createElement('div')),
      show = () => {
        const leaking = this.leaking;
        row.textContent = leaking.length ? `Leak? ${leaking.join(', ')}` : 'No leaks seen';
      };
    stats.element.append(row);
    show();
    this.timer = setInterval(show, 500);
    return this;
  }
  /** Stops sampling and removes the view. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.interval);
    clearInterval(this.timer);
    this.row?.remove();
    this.row = undefined;
    this.listeners.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
