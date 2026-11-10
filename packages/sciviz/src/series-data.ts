import { rangeError } from '../../shared/errors.js';
/** Time-ordered original observations. NaN y marks a discontinuity; x is finite and nondecreasing. */
export interface SeriesValues { readonly x: ArrayLike<number>; readonly y: ArrayLike<number>; }
/** Owned binary64 blocks. Progressive appends never copy previously loaded samples. */
export class TimeSeries extends EventTarget {
  readonly #chunks: { start: number; x: Float64Array; y: Float64Array }[] = [];
  #length = 0;
  #bounds: [number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity];
  constructor(data?: SeriesValues) { super(); if (data) this.append(data); }
  get length(): number { return this.#length; }
  get bounds(): readonly [number, number, number, number] { return [...this.#bounds]; }
  /** Copies one block after validating its complete ordering. Emits change after publishing it. */
  append(data: SeriesValues): void {
    if (data.x.length !== data.y.length || !Number.isSafeInteger(data.x.length) || data.x.length < 0 || data.x.length + this.#length > 0xffffffff) throw rangeError('Supply aligned series arrays with at most 4294967295 total rows', 'sciviz');
    const x = Float64Array.from(data.x), y = Float64Array.from(data.y), bounds = [...this.#bounds] as [number, number, number, number];
    let previous = bounds[1];
    for (let i = 0; i < x.length; i++) {
      if (!Number.isFinite(x[i]) || x[i] < previous || (!Number.isFinite(y[i]) && !Number.isNaN(y[i]))) throw rangeError('Use finite nondecreasing times and finite values or NaN gaps', 'sciviz');
      previous = x[i]; bounds[0] = Math.min(bounds[0], x[i]); bounds[1] = x[i];
      if (Number.isFinite(y[i])) { bounds[2] = Math.min(bounds[2], y[i]); bounds[3] = Math.max(bounds[3], y[i]); }
    }
    if (!x.length) return;
    this.#chunks.push({ start: this.#length, x, y }); this.#length += x.length; this.#bounds = bounds;
    this.dispatchEvent(new Event('change'));
  }
  #chunk(row: number) {
    if (!Number.isInteger(row) || row < 0 || row >= this.#length) throw rangeError('Read an original series row within its length', 'sciviz');
    let lo = 0, hi = this.#chunks.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (this.#chunks[mid].start <= row) lo = mid; else hi = mid; }
    return this.#chunks[lo];
  }
  x(row: number): number { const c = this.#chunk(row); return c.x[row - c.start]; }
  y(row: number): number { const c = this.#chunk(row); return c.y[row - c.start]; }
  /** First original row at or after time (after when strict=true). O(log rows). */
  lowerBound(time: number, strict = false): number {
    let lo = 0, hi = this.length;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2), x = this.x(mid); if (x < time || (strict && x === time)) lo = mid + 1; else hi = mid; }
    return lo;
  }
  /** Exact original-row predicate; independent of display sampling. */
  select(predicate: (x: number, y: number, row: number) => boolean, signal?: AbortSignal): Uint32Array {
    const rows: number[] = [];
    for (const c of this.#chunks) for (let i = 0; i < c.x.length; i++) {
      if (!(i & 16383)) signal?.throwIfAborted();
      if (Number.isFinite(c.y[i]) && predicate(c.x[i], c.y[i], c.start + i)) rows.push(c.start + i);
    }
    return Uint32Array.from(rows);
  }
}
/** Display method. Only M4 carries the paper's pixel-column envelope guarantee; LTTB is a visual heuristic. */
export type SeriesMethod = 'min-max' | 'm4' | 'lttb';
/** Buckets are in displayed x coordinates, with one neighbour retained on either side of the viewport. */
export interface DownsampleOptions {
  readonly width: number;
  /** Default m4. */ readonly method?: SeriesMethod;
  /** Default original x extent. */ readonly domain?: readonly [number, number];
  /** Monotonic mapping, default identity; use the figure's x scale for log/date axes. */ readonly transformX?: (x: number) => number;
  /** LTTB also retains each pixel's min/max, default true. Set false for the paper's exact threshold. */ readonly preserveExtremes?: boolean;
  readonly signal?: AbortSignal;
}
/** Original row IDs in increasing source order, including NaN gap markers. No averaged/synthetic values. */
export function downsampleSeries(series: TimeSeries, options: DownsampleOptions): Uint32Array {
  const width = options.width, method = options.method ?? 'm4'; options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(width) || width < 1 || width > 1000000 || !['m4', 'min-max', 'lttb'].includes(method)) throw rangeError('Choose m4, min-max or lttb and an integer pixel width from 1 to 1000000', 'sciviz');
  if (!series.length) return new Uint32Array();
  const domain = options.domain ?? series.bounds.slice(0, 2), transform = options.transformX ?? ((x: number) => x), lo = transform(domain[0]), hi = transform(domain[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) throw rangeError('Use finite ordered domain endpoints under transformX', 'sciviz');
  const start = Math.max(0, series.lowerBound(domain[0]) - 1), end = Math.min(series.length, series.lowerBound(domain[1], true) + 1), chosen = new Set<number>();
  const span = hi - lo, scaleX = width / span;
  const pixel = (i: number) => {
    const x = transform(series.x(i));
    if (hi === lo) return 0;
    if (!Number.isFinite(span)) return ((x / 2 - lo / 2) / (hi / 2 - lo / 2)) * width;
    return Number.isFinite(scaleX) ? (x - lo) * scaleX : ((x - lo) / span) * width;
  };
  const bucket = (i: number) => Math.floor(pixel(i));
  const run = (a: number, b: number) => {
    if (a >= b) return;
    chosen.add(a); chosen.add(b - 1);
    let first = a, min = a, max = a, column = bucket(a);
    const finish = (last: number) => {
      if (method === 'm4') { chosen.add(first); chosen.add(last); }
      if (method !== 'lttb' || options.preserveExtremes !== false) { chosen.add(min); chosen.add(max); }
    };
    for (let i = a + 1; i < b; i++) {
      if (!(i & 16383)) options.signal?.throwIfAborted();
      const next = bucket(i);
      if (next !== column) { finish(i - 1); first = min = max = i; column = next; }
      if (series.y(i) < series.y(min)) min = i;
      if (series.y(i) > series.y(max)) max = i;
    }
    finish(b - 1);
    if (method !== 'lttb') return;
    const threshold = Math.max(3, width), n = b - a;
    if (n <= threshold) { for (let i = a; i < b; i++) chosen.add(i); return; }
    const step = (n - 2) / (threshold - 2), scaleY = Math.max(Math.abs(series.bounds[2]), Math.abs(series.bounds[3])) || 1; let anchor = a;
    for (let j = 0; j < threshold - 2; j++) {
      options.signal?.throwIfAborted();
      const nextStart = a + Math.floor((j + 1) * step) + 1, nextEnd = Math.min(b, a + Math.floor((j + 2) * step) + 1);
      let avgX = 0, avgY = 0;
      for (let k = nextStart; k < nextEnd; k++) { avgX += pixel(k) / width; avgY += (series.y(k) / scaleY) / (nextEnd - nextStart); }
      avgX /= nextEnd - nextStart;
      const from = a + Math.floor(j * step) + 1, to = Math.min(b - 1, a + Math.floor((j + 1) * step) + 1), ax = pixel(anchor) / width, ay = series.y(anchor) / scaleY;
      let best = from, area = -1;
      for (let k = from; k < to; k++) {
        const value = Math.abs((ax - avgX) * (series.y(k) / scaleY - ay) - (ax - pixel(k) / width) * (avgY - ay));
        if (value > area) { area = value; best = k; }
      }
      chosen.add(best); anchor = best;
    }
  };
  let a = start;
  for (let i = start; i < end; i++) if (Number.isNaN(series.y(i))) { run(a, i); chosen.add(i); a = i + 1; }
  run(a, end);
  return Uint32Array.from([...chosen].sort((a, b) => a - b));
}
