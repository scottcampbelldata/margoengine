/// <reference lib="esnext.disposable" preserve="true" />
import type { Figure, LineLayer, LineLayerOptions } from './figure.js';
import { TimeSeries, downsampleSeries, type SeriesMethod } from './series-data.js';
import { readSeries, type SeriesSource, type SeriesReadOptions } from './series-source.js';
import { inRegion, type SelectRegion } from './pick.js';
import { fault, rangeError } from '../../shared/errors.js';
/** Styling and progressive loading. The caller sets figure limits; display sampling follows its pixel width and x scale. */
export interface SeriesBindingOptions extends LineLayerOptions {
  /** Default m4. */ readonly method?: SeriesMethod;
  readonly signal?: AbortSignal;
  /** Re-sample after wheel, pointerup and resize, default true. */ readonly interactive?: boolean;
}
/** Exact original observations linked to a bounded display trace. Selection events carry original row IDs as detail. */
export interface SeriesBinding extends EventTarget {
  readonly data: TimeSeries;
  readonly layers: readonly LineLayer[];
  readonly indices: Uint32Array;
  readonly selected: Uint32Array;
  readonly error: unknown;
  refresh(): Promise<void>;
  /** Exact original samples in a canvas CSS-pixel rectangle or lasso. Also runs on Figure selection events. */
  select(region: SelectRegion): Uint32Array;
  /** Decode and draw each incoming batch; progress events contain SeriesChunk, after its draw completes. */
  load(source: SeriesSource, options: SeriesReadOptions & { readonly x: string; readonly y: string }): Promise<void>;
  dispose(): void;
  [Symbol.dispose](): void;
}
/** Bind original data to a 2D figure. Redraws never replace the selection source with sampled vertices. */
export async function bindSeries(figure: Figure, data: TimeSeries, options: SeriesBindingOptions = {}): Promise<SeriesBinding> {
  options.signal?.throwIfAborted();
  if (!figure.is2d) throw rangeError('Bind a time series to a 2D figure', 'sciviz');
  const own = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, own.signal]) : own.signal;
  const canvas = figure.engine.canvas as HTMLCanvasElement, events = new EventTarget();
  let layers: LineLayer[] = [], indices: Uint32Array = new Uint32Array(), selected: Uint32Array = new Uint32Array(), error: unknown, disposed = false, loading = false;
  let pending: Promise<void> = Promise.resolve();
  const check = () => { signal.throwIfAborted(); if (disposed) throw fault('disposed', 'Create a new series binding after disposal', 'sciviz'); };
  const refresh = (): Promise<void> => {
    const run = async () => {
      check(); const bounds = figure.bounds, scales = figure.axisScales;
      const nextIndices = downsampleSeries(data, { width: Math.max(1, Math.ceil(figure.plotArea.width * (globalThis.devicePixelRatio ?? 1))), method: options.method, domain: [scales[0].inverse(bounds[0]), scales[0].inverse(bounds[1])], transformX: (x) => scales[0].forward(x), signal });
      const next: LineLayer[] = []; let x: number[] = [], y: number[] = [];
      const finish = async () => { if (x.length === 1) { x.push(x[0]); y.push(y[0]); } if (x.length) next.push(await figure.line({ x: Float64Array.from(x), y: Float64Array.from(y) }, options)); x = []; y = []; };
      try {
        for (const row of nextIndices) { const value = data.y(row); if (Number.isNaN(value)) await finish(); else { x.push(data.x(row)); y.push(value); } }
        await finish(); check();
        for (const layer of layers) figure.remove(layer); layers = next; indices = nextIndices; error = undefined; await figure.ready(); figure.render();
      } catch (cause) { for (const layer of next) figure.remove(layer); throw cause; }
    };
    const result = pending.then(run); pending = result.then(() => {}, () => {}); return result;
  };
  const changed = () => {
    if (loading || disposed) return;
    void refresh().catch((cause: unknown) => { if (!signal.aborted) { error = cause; events.dispatchEvent(new CustomEvent('error', { detail: cause })); } });
  };
  const select = (region: SelectRegion) => {
    check(); const bounds = figure.bounds, area = figure.plotArea, scales = figure.axisScales;
    selected = data.select((x, y) => {
      const px = area.x + (scales[0].forward(x) - bounds[0]) / (bounds[1] - bounds[0]) * area.width;
      const py = area.y + (bounds[3] - scales[1].forward(y)) / (bounds[3] - bounds[2]) * area.height;
      return px >= area.x && px <= area.x + area.width && py >= area.y && py <= area.y + area.height && inRegion(px, py, region);
    }, signal);
    events.dispatchEvent(new CustomEvent('selection', { detail: selected.slice() })); return selected.slice();
  };
  const selection = (event: Event) => { select((event as CustomEvent<{ region: SelectRegion }>).detail.region); };
  const observer = options.interactive !== false && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(changed) : undefined;
  const dispose = () => {
    if (disposed) return; disposed = true; own.abort(); observer?.disconnect();
    data.removeEventListener('change', changed); figure.removeEventListener('selection', selection);
    canvas.removeEventListener('wheel', changed); canvas.removeEventListener('pointerup', changed); options.signal?.removeEventListener('abort', dispose);
    for (const layer of layers) figure.remove(layer); layers = [];
  };
  const binding = Object.assign(events, {
    data, refresh, select,
    async load(source: SeriesSource, read: SeriesReadOptions & { readonly x: string; readonly y: string }) {
      check(); if (loading) throw fault('state', 'Wait for the current series load before starting another', 'sciviz');
      loading = true;
      const loadSignal = read.signal ? AbortSignal.any([signal, read.signal]) : signal;
      try {
        for await (const chunk of readSeries(source, { ...read, signal: loadSignal })) {
          const x = new Float64Array(chunk.table.length), y = new Float64Array(chunk.table.length);
          for (let i = 0; i < x.length; i++) {
            const time = chunk.table.value(read.x, i), value = chunk.table.value(read.y, i);
            if (typeof time !== 'number' || (value !== null && typeof value !== 'number')) throw rangeError('Use numeric series columns; convert integer timestamps explicitly before binding', 'sciviz');
            x[i] = time; y[i] = value === null ? NaN : value;
          }
          loadSignal.throwIfAborted(); data.append({ x, y }); await refresh(); loadSignal.throwIfAborted();
          events.dispatchEvent(new CustomEvent('progress', { detail: chunk }));
        }
      } finally { loading = false; }
    },
    dispose, [Symbol.dispose]: dispose,
  });
  Object.defineProperties(binding, {
    layers: { get: () => [...layers] }, indices: { get: () => indices.slice() }, selected: { get: () => selected.slice() }, error: { get: () => error },
  });
  try {
    await refresh(); data.addEventListener('change', changed); figure.addEventListener('selection', selection);
    if (options.interactive !== false) { canvas.addEventListener('wheel', changed, { passive: true }); canvas.addEventListener('pointerup', changed); observer?.observe(canvas); }
    options.signal?.addEventListener('abort', dispose, { once: true }); return binding as SeriesBinding;
  } catch (cause) { dispose(); throw cause; }
}
