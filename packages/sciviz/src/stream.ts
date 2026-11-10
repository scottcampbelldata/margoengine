// Optional live line/scatter updates, owned rollover data and deterministic sliding time windows.
import type { Figure, LineLayer, ScatterLayer } from './figure.js';
import { fault, rangeError } from '../../shared/errors.js';
import { chartDataAdapters } from './chart-data.js';
export * from './stream-sources.js';
/** One x/y sample per row, optional z/color/size channels; every supplied channel has the same length. */
export interface LiveData {
  readonly x: ArrayLike<number>;
  readonly y: ArrayLike<number>;
  readonly z?: ArrayLike<number>;
  readonly color?: ArrayLike<number>;
  readonly size?: ArrayLike<number>;
}
/** Patches replace a contiguous range of only the supplied channels. */
export type LivePatch = Partial<LiveData>;
/** Rollover defaults to 10000 samples (maximum 1000000). Optional data retains original double-precision observations. */
export interface StreamLayerOptions {
  readonly rollover?: number;
  readonly data?: LiveData;
  readonly signal?: AbortSignal;
}
/** Methods attached to the actual Figure layer; native identity, styles and pick references remain stable. */
export interface StreamMethods {
  readonly streamData: LiveData;
  append(data: LiveData): Promise<void>;
  patch(index: number, data: LivePatch): Promise<void>;
  disposeStream(): void;
  [Symbol.dispose](): void;
}
/** A native line/scatter layer with bounded live updates. */
export type LiveLayer<L extends LineLayer | ScatterLayer = LineLayer | ScatterLayer> = L & StreamMethods;
type Channel = 'x' | 'y' | 'z' | 'color' | 'size';
type Owned = Partial<Record<Channel, Float64Array>> & { x: Float64Array; y: Float64Array };
const channels: readonly Channel[] = ['x', 'y', 'z', 'color', 'size'];
const bindings = new WeakMap<object, { disposed: boolean }>();
function snapshot(data: LivePatch, complete: boolean): Partial<Record<Channel, Float64Array>> {
  const out: Partial<Record<Channel, Float64Array>> = {};
  let count: number | undefined;
  for (const key of channels) {
    const a = data[key];
    if (a === undefined) continue;
    if (!Number.isSafeInteger(a.length) || a.length < 0 || a.length > 1000000)
      throw rangeError('Use live data channels with at most 1000000 samples', 'sciviz');
    if (count === undefined) count = a.length;
    if (a.length !== count) throw rangeError('Align every supplied live-data channel to one length', 'sciviz');
    const values = Float64Array.from(a);
    if (values.some((v) => !Number.isFinite(v)))
      throw rangeError('Supply finite live observations, filtering missing values first', 'sciviz');
    out[key] = values;
  }
  if ((complete && (!out.x || !out.y)) || count === undefined)
    throw rangeError('Supply x and y for append, or at least one channel for patch', 'sciviz');
  return out;
}
/** Attach append/patch to a native editable line or scatter. Calls serialize, snapshot inputs immediately and publish only completed GPU replacements. */
export async function streamLayer<L extends LineLayer | ScatterLayer>(
  figure: Figure,
  layer: L,
  options: StreamLayerOptions = {},
): Promise<LiveLayer<L>> {
  options.signal?.throwIfAborted();
  const rollover = options.rollover ?? 10000;
  if (
    !Number.isSafeInteger(rollover) ||
    rollover < (layer.kind === 'line' ? 2 : 1) ||
    rollover > 1000000 ||
    !figure.layers.includes(layer) ||
    ('append' in layer && !bindings.get(layer)?.disposed)
  )
    throw rangeError(
      'Choose an unbound native line/scatter in this figure and a rollover of 2..1000000 for lines or 1..1000000 for scatter',
      'sciviz',
    );
  const n = layer.positions.length / 3,
    scales = figure.axisScales,
    initial: LiveData = {
      ...{
        x: Float64Array.from({ length: n }, (_, i) => scales[0].inverse(layer.positions[i * 3])),
        y: Float64Array.from({ length: n }, (_, i) => scales[1].inverse(layer.positions[i * 3 + 1])),
        z: Float64Array.from({ length: n }, (_, i) => scales[2].inverse(layer.positions[i * 3 + 2])),
        color: layer.values,
        size: layer.kind === 'scatter' ? (layer.cloud.sizes ?? undefined) : undefined,
      },
      ...chartDataAdapters.get(figure)?.read(layer),
      ...options.data,
    };
  let state = snapshot(initial, true) as Owned;
  if (state.x.length !== n) throw rangeError('Match initial live data to the existing layer sample count', 'sciviz');
  if (layer.kind === 'line' && state.size) throw rangeError('Use per-point sizes only with a scatter layer', 'sciviz');
  for (const key of channels) if (state[key]) state[key] = state[key]!.slice(-rollover);
  const own = new AbortController(),
    signal = options.signal ? AbortSignal.any([options.signal, own.signal]) : own.signal,
    update = async (data: Owned) => {
      const adapter = chartDataAdapters.get(figure);
      if (adapter) await adapter.update(layer, data, signal);
      else await figure.updateData(layer, data, { signal });
    },
    binding = { disposed: false };
  await update(state);
  bindings.set(layer, binding);
  let disposed = false,
    pending: Promise<void> = Promise.resolve();
  const check = () => {
    signal.throwIfAborted();
    if (disposed) throw fault('disposed', 'Bind a new live layer after disposing this stream', 'sciviz');
  };
  const commit = (operation: () => Owned): Promise<void> => {
    const run = async () => {
      check();
      const next = operation();
      if (next === state) return;
      await update(next);
      state = next;
    };
    const result = pending.then(run, run);
    pending = result;
    return result;
  };
  const append = async (input: LiveData): Promise<void> => {
    check();
    const data = snapshot(input, true) as Owned;
    return commit(() => {
      const count = data.x.length;
      if (!count) return state;
      for (const key of ['color', 'size'] as const)
        if (Boolean(data[key]) !== Boolean(state[key]))
          throw rangeError(`Supply the same ${key} channel on every append as on the original trace`, 'sciviz');
      const next = {} as Owned,
        newCount = Math.min(rollover, state.x.length + count),
        oldCount = Math.max(0, newCount - count),
        take = Math.min(count, newCount);
      for (const key of channels) {
        if (!state[key] && !data[key]) continue;
        const values = new Float64Array(newCount);
        if (state[key]) values.set(state[key]!.subarray(state.x.length - oldCount), 0);
        if (data[key]) values.set(data[key]!.subarray(count - take), oldCount);
        next[key] = values;
      }
      return next;
    });
  };
  const patch = async (index: number, input: LivePatch): Promise<void> => {
    check();
    const data = snapshot(input, false),
      length = Object.values(data)[0]!.length;
    if (!Number.isSafeInteger(index) || index < 0) throw rangeError('Use a nonnegative integer patch index', 'sciviz');
    return commit(() => {
      if (index + length > state.x.length)
        throw rangeError('Keep patches inside the current rollover window', 'sciviz');
      const next = {} as Owned;
      for (const key of channels) {
        if (data[key] && !state[key]) throw rangeError(`Create the ${key} channel before patching it`, 'sciviz');
        if (state[key]) {
          const values = state[key]!.slice();
          if (data[key]) values.set(data[key]!, index);
          next[key] = values;
        }
      }
      return next;
    });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    binding.disposed = true;
    own.abort(fault('disposed', 'Bind a new stream after disposing live updates', 'sciviz'));
    options.signal?.removeEventListener('abort', dispose);
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  Object.defineProperties(layer, {
    streamData: {
      configurable: true,
      get: () => {
        const copy = {} as Owned;
        for (const key of channels) if (state[key]) copy[key] = state[key]!.slice();
        return copy;
      },
    },
    append: { configurable: true, value: append },
    patch: { configurable: true, value: patch },
    disposeStream: { configurable: true, value: dispose },
    [Symbol.dispose]: { configurable: true, value: dispose },
  });
  return layer as LiveLayer<L>;
}
/** Exact first-order smoothing for a fixed target; elapsed/smoothing in caller-consistent time units, smoothing 0 snaps. */
export function smoothTime(current: number, target: number, elapsed: number, smoothing: number): number {
  if (![current, target, elapsed, smoothing].every(Number.isFinite) || elapsed < 0 || smoothing < 0)
    throw rangeError('Use finite times and nonnegative elapsed/smoothing values', 'sciviz');
  if (smoothing === 0) return target;
  const weight = -Math.expm1(-elapsed / smoothing);
  const difference = target - current;
  return Number.isFinite(difference) ? current + difference * weight : current * (1 - weight) + target * weight;
}
/** Window duration in x-axis milliseconds, smoothing 250 ms, initial end defaults to current right data bound. Clock defaults to performance.now. */
export interface TimeWindowOptions {
  readonly duration: number;
  readonly smoothing?: number;
  readonly end?: number;
  readonly clock?: () => number;
  readonly signal?: AbortSignal;
}
/** Smooth original-time x limits with deterministic advance() for replay/testing. Owns only its frame listener. */
export class SlidingTimeWindow {
  readonly figure: Figure;
  readonly duration: number;
  readonly smoothing: number;
  readonly #clock: () => number;
  readonly #off: () => void;
  readonly #signal: AbortSignal | undefined;
  readonly #abort: () => void;
  #last: number;
  #end: number;
  #target: number;
  #disposed = false;
  constructor(figure: Figure, options: TimeWindowOptions) {
    options.signal?.throwIfAborted();
    if (
      !figure.is2d ||
      figure.axisScales[0].type === 'log' ||
      !Number.isFinite(options.duration) ||
      options.duration <= 0 ||
      !Number.isFinite(options.smoothing ?? 250) ||
      (options.smoothing ?? 250) < 0
    )
      throw rangeError('Use a 2D linear/date x axis, positive duration and nonnegative smoothing', 'sciviz');
    this.figure = figure;
    this.duration = options.duration;
    this.smoothing = options.smoothing ?? 250;
    this.#clock = options.clock ?? (() => performance.now());
    this.#last = this.#clock();
    this.#end =
      options.end ??
      chartDataAdapters.get(figure)?.inverseX(figure.bounds[1]) ??
      figure.axisScales[0].inverse(figure.bounds[1]);
    this.#target = this.#end;
    this.#apply();
    this.#off = figure.engine.onFrame(() => {
      const now = this.#clock();
      this.advance(Math.max(0, now - this.#last));
      this.#last = now;
    });
    this.#signal = options.signal;
    this.#abort = () => this.dispose();
    options.signal?.addEventListener('abort', this.#abort, { once: true });
  }
  /** Current displayed right edge, in original time units. */
  get end(): number {
    return this.#end;
  }
  /** Current target right edge. */
  get target(): number {
    return this.#target;
  }
  #apply() {
    if (!Number.isFinite(this.#end) || !Number.isFinite(this.#end - this.duration))
      throw rangeError('Choose a representable finite time window', 'sciviz');
    const b = this.figure.bounds,
      forward = chartDataAdapters.get(this.figure)?.forwardX ?? this.figure.axisScales[0].forward;
    this.figure.setLimits([forward(this.#end - this.duration), forward(this.#end), b[2], b[3]]);
  }
  /** Change the target; snap=true bypasses smoothing for seeks. */
  setTime(time: number, snap = false): void {
    if (this.#disposed) throw fault('disposed', 'Create a new time window after disposal', 'sciviz');
    if (!Number.isFinite(time) || !Number.isFinite(time - this.duration))
      throw rangeError('Use a finite representable time-window end', 'sciviz');
    this.#target = time;
    if (snap || this.smoothing === 0) {
      this.#end = time;
      this.#apply();
    }
  }
  /** Advance smoothing by explicit elapsed milliseconds; no wall-clock or speed assertion is needed. */
  advance(elapsed: number): void {
    if (this.#disposed) return;
    if (!Number.isFinite(elapsed) || elapsed < 0)
      throw rangeError('Advance a time window by nonnegative finite milliseconds', 'sciviz');
    if (elapsed === 0 || this.#end === this.#target) return;
    this.#end = smoothTime(this.#end, this.#target, elapsed, this.smoothing);
    if (Math.abs(this.#end - this.#target) <= Number.EPSILON * Math.max(1, Math.abs(this.#target)))
      this.#end = this.#target;
    this.#apply();
  }
  /** Stop automatic scrolling, leaving the last view in place. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#off();
    this.#signal?.removeEventListener('abort', this.#abort);
  }
  /** Same as dispose(), for using. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
