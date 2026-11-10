// Clean room: Welford (1962), Chan/Golub/LeVeque (1983), CF 1.12 and ParaView's documented series format.
import { rangeError } from '../../shared/errors.js';
import type { Figure, LineLayer, LineLayerOptions, ScatterLayer } from './figure.js';
import type { ProbeInput } from './probe.js';
export { parseTimeUnits, convertTimeUnits, formatTemporalTime } from './temporal-units.js';
export type { TemporalTimeUnits } from './temporal-units.js';
export { groupFileSeries, parseFileSeries, fileSeriesSource } from './temporal-files.js';
export type { TemporalFile, TemporalFileSeries, FileSeriesOptions } from './temporal-files.js';

/** A lazy sequence. The reader borrows its result only until the next read. Times must be finite and strictly increasing. */
export interface TemporalSource<T = ArrayLike<number>> {
  readonly times: ArrayLike<number>;
  readonly read: (index: number, options: TemporalOptions) => T | Promise<T>;
}
/** Cancellation is checked before and after every read and during long CPU operations. */
export interface TemporalOptions { readonly signal?: AbortSignal }
/** Half-open step selection. Statistics weight steps equally, not by duration. */
export interface TemporalStatisticsOptions extends TemporalOptions {
  readonly start?: number;
  readonly stop?: number;
  /** Population (0, default) or sample (1) standard deviation. */
  readonly ddof?: 0 | 1;
  /** NaN treatment: omit (default), propagate, or error. Infinity always rejects. */
  readonly missing?: 'omit' | 'propagate' | 'error';
}
/** One owned float64 value per field element. Empty observations and insufficient variance counts give NaN. */
export interface TemporalStatistics {
  readonly count: Float64Array;
  readonly mean: Float64Array;
  readonly minimum: Float64Array;
  readonly maximum: Float64Array;
  readonly standardDeviation: Float64Array;
  readonly steps: number;
}
/** Interpolation defaults to linear, with an error outside the available interval. NaN endpoints remain missing. */
export interface TemporalInterpolationOptions extends TemporalOptions {
  readonly method?: 'linear' | 'nearest' | 'step';
  readonly outside?: 'error' | 'clamp';
}
const bad = (text: string) => rangeError(`Temporal: ${text}`, 'sciviz');
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** @internal Validated snapshot prevents a caller changing step times across an await. */
function temporalTimes(times: ArrayLike<number>): Float64Array {
  if (!times || !Number.isSafeInteger(times.length) || times.length < 1) throw bad('supply at least one step');
  const out = Float64Array.from(times);
  for (let i = 0; i < out.length; i++)
    if (!Number.isFinite(out[i]) || (i > 0 && out[i] <= out[i - 1])) throw bad('times must be finite and strictly increasing');
  return out;
}
async function frame(source: TemporalSource, index: number, options: TemporalOptions, length?: number) {
  options.signal?.throwIfAborted();
  const values = await source.read(index, options);
  options.signal?.throwIfAborted();
  if (!values || !Number.isSafeInteger(values.length) || values.length < 1 || (length !== undefined && values.length !== length))
    throw bad('every frame must have the same nonzero field length');
  const out = new Float64Array(values.length);
  for (let i = 0; i < out.length; i++) {
    if (i && i % 65536 === 0) { await pause(); options.signal?.throwIfAborted(); }
    const value = values[i];
    if (typeof value !== 'number' || (!Number.isFinite(value) && !Number.isNaN(value))) throw bad('field values must be finite numbers or NaN');
    out[i] = value;
  }
  return out;
}

/** Streaming shifted Welford accumulation: O(field length) field storage plus a time-axis snapshot, one read per selected step. */
export async function temporalStatistics(source: TemporalSource, options: TemporalStatisticsOptions = {}): Promise<TemporalStatistics> {
  options.signal?.throwIfAborted();
  const times = temporalTimes(source.times), start = options.start ?? 0, stop = options.stop ?? times.length,
    ddof = options.ddof ?? 0, missing = options.missing ?? 'omit';
  if (!Number.isInteger(start) || !Number.isInteger(stop) || start < 0 || stop > times.length || start >= stop)
    throw bad('start/stop must select at least one available step');
  if (ddof !== 0 && ddof !== 1) throw bad('ddof must be 0 or 1');
  if (!['omit', 'propagate', 'error'].includes(missing)) throw bad('unknown missing-value policy');
  const first = await frame(source, start, options), n = first.length,
    count = new Float64Array(n), mean = new Float64Array(n), origin = new Float64Array(n), m2 = new Float64Array(n),
    minimum = new Float64Array(n).fill(Infinity), maximum = new Float64Array(n).fill(-Infinity), invalid = new Uint8Array(n);
  for (let step = start; step < stop; step++) {
    const values = step === start ? first : await frame(source, step, options, n);
    for (let i = 0; i < n; i++) {
      if (i && i % 65536 === 0) { await pause(); options.signal?.throwIfAborted(); }
      const x = values[i];
      if (Number.isNaN(x)) {
        if (missing === 'error') throw bad(`missing value at step ${step}, element ${i}`);
        invalid[i] = 1; continue;
      }
      if (!count[i]) origin[i] = x;
      const shifted = x - origin[i], delta = shifted - mean[i];
      mean[i] += delta / ++count[i];
      m2[i] += delta * (shifted - mean[i]);
      minimum[i] = Math.min(minimum[i], x); maximum[i] = Math.max(maximum[i], x);
      if (!Number.isFinite(mean[i]) || !Number.isFinite(m2[i])) throw bad('statistics overflow; rescale the field');
    }
    await pause(); options.signal?.throwIfAborted();
  }
  const standardDeviation = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const absent = !count[i] || (missing === 'propagate' && invalid[i]);
    standardDeviation[i] = absent || count[i] <= ddof ? NaN : Math.sqrt(m2[i] / (count[i] - ddof));
    if (absent) mean[i] = minimum[i] = maximum[i] = NaN;
    else mean[i] += origin[i];
  }
  return { count, mean, minimum, maximum, standardDeviation, steps: stop - start };
}

/** Exact keys read only that frame; nearest ties choose the earlier step. No extrapolation or hidden frame cache. */
export async function interpolateTemporal(source: TemporalSource, time: number, options: TemporalInterpolationOptions = {}): Promise<Float64Array> {
  options.signal?.throwIfAborted();
  const times = temporalTimes(source.times), method = options.method ?? 'linear', outside = options.outside ?? 'error';
  if (!Number.isFinite(time) || !['linear', 'nearest', 'step'].includes(method) || !['error', 'clamp'].includes(outside))
    throw bad('supply a finite time and valid interpolation/outside policy');
  if (time < times[0] || time > times[times.length - 1]) {
    if (outside === 'error') throw bad('time outside the available interval');
    time = Math.max(times[0], Math.min(times[times.length - 1], time));
  }
  let lo = 0, hi = times.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (times[mid] <= time) lo = mid; else hi = mid - 1; }
  if (times[lo] === time || method === 'step') return frame(source, lo, options);
  const interval = times[lo + 1] - times[lo],
    alpha = Number.isFinite(interval) ? (time - times[lo]) / interval : (time / 2 - times[lo] / 2) / (times[lo + 1] / 2 - times[lo] / 2);
  if (method === 'nearest') return frame(source, alpha <= 0.5 ? lo : lo + 1, options);
  const a = await frame(source, lo, options), b = await frame(source, lo + 1, options, a.length);
  for (let i = 0; i < a.length; i++) {
    if (i && i % 65536 === 0) { await pause(); options.signal?.throwIfAborted(); }
    // Weighted endpoints avoid overflow of (b-a) for opposite large finite values.
    a[i] = (1 - alpha) * a[i] + alpha * b[i];
  }
  return a;
}

/** Spatial probe selection. Default unnamed point scalar, component 0; cell association remains distinct. */
export interface TemporalProbeOptions extends TemporalOptions {
  readonly association?: 'point' | 'cell';
  readonly field?: string;
  readonly component?: number;
}
/** One owned observation per step; a point outside that step's mesh has NaN and valid=0. */
export interface TemporalProbe {
  readonly times: Float64Array;
  readonly values: Float64Array;
  readonly valid: Uint8Array;
}
/** Sample the same physical point in every frame, including moving meshes. The spatial locator is loaded lazily. */
export async function probeTemporal(source: TemporalSource<ProbeInput>, position: readonly [number, number, number], options: TemporalProbeOptions = {}): Promise<TemporalProbe> {
  options.signal?.throwIfAborted();
  const times = temporalTimes(source.times), at = [...position] as [number, number, number],
    component = options.component ?? 0, association = options.association ?? 'point';
  if (at.length !== 3 || !at.every(Number.isFinite) || !Number.isInteger(component) || component < 0 || !['point', 'cell'].includes(association))
    throw bad('supply a finite xyz point, valid association and nonnegative component');
  const { probeGrid } = await import('@margoengine/sciviz/probe'), values = new Float64Array(times.length).fill(NaN), valid = new Uint8Array(times.length);
  for (let i = 0; i < times.length; i++) {
    options.signal?.throwIfAborted();
    const grid = await source.read(i, options);
    options.signal?.throwIfAborted();
    const sample = await probeGrid(grid, at, options);
    options.signal?.throwIfAborted();
    if (sample) {
      const scalar = association === 'point' ? sample.pointData : sample.cellData,
        tuple = options.field ? (association === 'point' ? sample.pointArrays : sample.cellArrays)[options.field] : scalar === undefined ? undefined : [scalar];
      if (!tuple || component >= tuple.length) throw bad(`probe field/component is absent at step ${i}`);
      const value = tuple[component];
      if (!Number.isFinite(value) && !Number.isNaN(value)) throw bad('probe value overflows');
      values[i] = value; valid[i] = Number.isFinite(value) ? 1 : 0;
    }
    await pause(); options.signal?.throwIfAborted();
  }
  return { times, values, valid };
}
/** Chart style. The x axis is time minus origin (default first step), preserving float32 precision for epoch times. */
export interface TemporalChartOptions extends LineLayerOptions, TemporalOptions { readonly origin?: number }
/** Chart owns its layers. Dispose it before disposing its figure. */
export interface TemporalChart {
  readonly origin: number;
  readonly layers: readonly (LineLayer | ScatterLayer)[];
  dispose(): void;
  [Symbol.dispose](): void;
}
/** Render a probe as native Figure lines, with gaps for missing steps and scatter marks for isolated observations. */
export async function plotTemporalProbe(figure: Figure, probe: TemporalProbe, options: TemporalChartOptions = {}): Promise<TemporalChart> {
  options.signal?.throwIfAborted();
  const times = temporalTimes(probe.times), origin = options.origin ?? times[0], values = Float64Array.from(probe.values), valid = Uint8Array.from(probe.valid);
  if (!Number.isFinite(origin) || values.length !== times.length || valid.length !== times.length) throw bad('invalid probe chart arrays/origin');
  const layers: (LineLayer | ScatterLayer)[] = [];
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; for (const layer of layers) figure.remove(layer); };
  try {
    for (let start = 0; start < times.length;) {
      if (!valid[start] || !Number.isFinite(values[start])) { start++; continue; }
      let stop = start + 1;
      while (stop < times.length && valid[stop] && Number.isFinite(values[stop])) stop++;
      options.signal?.throwIfAborted();
      const data = { x: times.slice(start, stop).map((t) => t - origin), y: values.slice(start, stop) };
      layers.push(stop - start > 1 ? await figure.line(data, options) : await figure.scatter(data, { color: options.color, name: options.name }));
      options.signal?.throwIfAborted();
      start = stop;
    }
    return { origin, layers, dispose, [Symbol.dispose]: dispose };
  } catch (error) { dispose(); throw error; }
}
