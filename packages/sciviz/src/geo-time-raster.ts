/// <reference lib="esnext.disposable" preserve="true" />
import type { WMTSImageryOptions } from '@margoengine/tiles/imagery';
import type { Figure } from './figure.js';
import type { Bounds } from './layer.js';
import type { Timeline, TimelineOptions } from './timeline.js';
import type { TileSource } from './geo.js';
import { tileBounds } from './geo.js';
import type { GeoLodLayer, GeoLodOptions } from './geo-lod.js';
import { dataToClip } from './pick.js';
import { fault, rangeError } from '../../shared/errors.js';

/** WMTS time dimension on the owning tiles/imagery URL builder, REST and KVP. */
export interface WMTSTimeOptions extends WMTSImageryOptions {
  /** Dimension identifier is case sensitive for REST templates. Default Time. */
  readonly timeDimension?: string;
  /** UTC milliseconds to the provider's dimension text. Default ISO 8601 UTC. */
  readonly formatTime?: (time: number) => string;
  readonly fetch?: typeof fetch;
}
/** Uses the owning WMTS builder lazily. Custom dimensions and access parameters survive. */
export async function wmtsTimeURL(
  options: WMTSTimeOptions,
  time: number,
  z: number,
  x: number,
  y: number,
): Promise<string> {
  if (
    !Number.isFinite(time) ||
    !Number.isInteger(z) ||
    z < 0 ||
    z > 30 ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** z ||
    y >= 2 ** z
  )
    throw rangeError('WMTS time needs finite UTC milliseconds and a valid XYZ tile', 'sciviz');
  const dimension = options.timeDimension ?? 'Time',
    value = options.formatTime?.(time) ?? new Date(time).toISOString();
  if (!dimension || !value) throw rangeError('WMTS time dimension and formatted time must be nonempty', 'sciviz');
  const { wmtsURL } = await import('@margoengine/tiles/imagery');
  return wmtsURL(
    { ...options, parameters: { ...options.parameters, [dimension]: value } },
    options.matrixLabels?.[z] ?? String(z),
    x,
    y,
  );
}
/** A fixed time frame's cancellable imagery source, suitable for geoLodLayer. */
export function wmtsTimeSource(options: WMTSTimeOptions, time: number): TileSource {
  return async (z, x, y, signal) => {
    signal?.throwIfAborted();
    const url = await wmtsTimeURL(options, time, z, x, y);
    signal?.throwIfAborted();
    if (options.matrices || options.projection === 'EPSG:4326') {
      const { wmts } = await import('@margoengine/tiles/imagery'),
        radians = Math.PI / 180,
        bounds = tileBounds(z, x, y),
        rectangle = bounds.map((v) => v * radians) as [number, number, number, number],
        dimension = options.timeDimension ?? 'Time',
        value = options.formatTime?.(time) ?? new Date(time).toISOString(),
        source = wmts({ ...options, parameters: { ...options.parameters, [dimension]: value } }),
        raster = await source.request(rectangle, z, options.fetch ?? fetch, signal ?? new AbortController().signal);
      try {
        signal?.throwIfAborted();
        const output = new OffscreenCanvas(256, 256),
          context = output.getContext('2d')!,
          width = raster.canvas.width,
          height = raster.canvas.height,
          west = rectangle[0],
          east = rectangle[2];
        if ((options.projection ?? 'EPSG:3857') === 'EPSG:3857') {
          const a = raster.uv(west, rectangle[3]),
            b = raster.uv(east, rectangle[1]);
          if (b[0] > a[0] && b[1] > a[1])
            context.drawImage(
              raster.canvas,
              a[0] * width,
              a[1] * height,
              (b[0] - a[0]) * width,
              (b[1] - a[1]) * height,
              0,
              0,
              256,
              256,
            );
        } else {
          // The owning service mosaics in geographic degrees. Canvas resamples each Mercator row without a JS pixel loop.
          for (let row = 0; row < 256; row++) {
            signal?.throwIfAborted();
            const latitude = (v: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + v)) / 2 ** z))),
              a = raster.uv(west, latitude(row / 256)),
              b = raster.uv(east, latitude((row + 1) / 256));
            if (b[0] > a[0] && b[1] > a[1])
              context.drawImage(
                raster.canvas,
                a[0] * width,
                a[1] * height,
                (b[0] - a[0]) * width,
                (b[1] - a[1]) * height,
                0,
                row,
                256,
                1,
              );
          }
        }
        return context.getImageData(0, 0, 256, 256);
      } finally {
        raster.close();
      }
    }
    const response = await (options.fetch ?? fetch)(url, { signal });
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw fault('failed', `WMTS time tile answered ${response.status}; check provider dimensions`, 'sciviz');
    return response.blob();
  };
}
/** Time-raster view and bounded frame cache. Service matrices are mosaicked/reprojected by the owning imagery API. */
export interface GeoTimeRasterOptions extends Omit<GeoLodOptions, 'tiles' | 'elevation' | 'clock'> {
  readonly source: WMTSTimeOptions;
  /** Available UTC Unix milliseconds, strictly increasing. Selects latest frame at or before the seek time. */
  readonly times: ArrayLike<number>;
  /** Retained frames, default 2, range 1..16. Each has its own bounded tile cache. */
  readonly cacheFrames?: number;
  /** Default first available frame. Times outside the availability clamp to its endpoints. */
  readonly time?: number;
}
/** Time selection reuses each frame's camera-driven tile cache, retained restore and abortable fetches. */
export class GeoTimeRasterLayer {
  readonly times: Float64Array;
  readonly #figure: Figure;
  readonly #options: GeoTimeRasterOptions;
  readonly #frames = new Map<number, GeoLodLayer>();
  readonly #lifetime = new AbortController();
  readonly #abort = () => this.dispose();
  #queue: Promise<void> = Promise.resolve();
  #active?: GeoLodLayer;
  #time = NaN;
  #visible = true;
  #disposed = false;
  #timeline?: Timeline;
  readonly #model = new Float32Array(16);
  /** @internal Use geoTimeRasterLayer. */
  constructor(figure: Figure, options: GeoTimeRasterOptions) {
    options.signal?.throwIfAborted();
    this.times = Float64Array.from(options.times);
    const capacity = options.cacheFrames ?? 2;
    if (
      !this.times.length ||
      !this.times.every((v, i) => Number.isFinite(v) && Math.abs(v) <= 8.64e15 && (i === 0 || v > this.times[i - 1])) ||
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      capacity > 16
    )
      throw rangeError('Time rasters need increasing valid UTC milliseconds and cacheFrames 1..16', 'sciviz');
    this.#figure = figure;
    this.#options = options;
    options.signal?.addEventListener('abort', this.#abort, { once: true });
  }
  get time(): number {
    return this.#time;
  }
  get visible(): boolean {
    return this.#visible;
  }
  set visible(value: boolean) {
    this.#visible = value;
    if (this.#active) this.#active.visible = value;
  }
  get bounds(): Bounds {
    return this.#active?.bounds ?? [-1, 1, -1, 1, -0.01, 0.01];
  }
  /** @internal */
  setModel(model: Float32Array): void {
    this.#model.set(model);
  }
  /** Resolves selected-frame imagery for the current camera. Failed seeks retain the previous visible frame. */
  seek(time: number, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (!Number.isFinite(time))
      return Promise.reject(rangeError('Raster seek needs finite UTC milliseconds', 'sciviz'));
    const run = this.#queue.then(async () => {
      if (this.#disposed) throw fault('disposed', 'Time raster disposed; create a new layer', 'sciviz');
      const signal = options.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal;
      signal.throwIfAborted();
      let lo = 0,
        hi = this.times.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (this.times[mid] <= time) lo = mid + 1;
        else hi = mid;
      }
      const selected = this.times[Math.max(0, lo - 1)];
      let layer = this.#frames.get(selected),
        created = false;
      if (!layer) {
        const { geoLodLayer } = await import('./geo-lod.js');
        signal.throwIfAborted();
        layer = geoLodLayer(this.#figure, {
          ...this.#options,
          tiles: wmtsTimeSource(this.#options.source, selected),
          fadeSeconds: this.#options.fadeSeconds ?? 0,
          signal: this.#lifetime.signal,
        });
        layer.visible = false;
        created = true;
      }
      try {
        // Selection can run while hidden, so no partial new frame replaces a complete old one.
        this.#figure.render();
        const renderer = this.#figure.renderer,
          camera = this.#figure.engine.camera;
        layer.updateView({
          matrix: dataToClip(camera.matrix, this.#model),
          width: renderer.engine.canvas.width,
          height: renderer.engine.canvas.height,
        });
        await layer.ready({ signal });
        signal.throwIfAborted();
        if (this.#active) this.#active.visible = false;
        this.#frames.delete(selected);
        this.#frames.set(selected, layer);
        this.#active = layer;
        this.#time = selected;
        layer.visible = this.#visible;
        while (this.#frames.size > (this.#options.cacheFrames ?? 2)) {
          const [key, old] = this.#frames.entries().next().value!;
          this.#frames.delete(key);
          this.#figure.remove(old);
        }
      } catch (error) {
        if (created) this.#figure.remove(layer);
        throw error;
      }
    });
    this.#queue = run.catch(() => {});
    return run;
  }
  /** Figure-owned asynchronous timeline playback. */
  timeline(times: ArrayLike<number> = this.times, options: TimelineOptions = {}): Timeline {
    if (this.#disposed) throw fault('disposed', 'Time raster disposed; create a new layer', 'sciviz');
    return (this.#timeline = this.#figure.timeline(times, (_, time) => this.seek(time), {
      format: (t) => new Date(t).toISOString(),
      ...options,
    }));
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifetime.abort();
    this.#timeline?.dispose();
    this.#options.signal?.removeEventListener('abort', this.#abort);
    for (const layer of this.#frames.values()) this.#figure.remove(layer);
    this.#frames.clear();
    this.#active = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Attach WMTS time-dimensional raster imagery to a map/globe with a bounded retained frame cache. */
export async function geoTimeRasterLayer(figure: Figure, options: GeoTimeRasterOptions): Promise<GeoTimeRasterLayer> {
  const layer = new GeoTimeRasterLayer(figure, options);
  // Add first so the figure supplies the data-to-scene transform used during hidden tile selection.
  figure.addLayer(layer);
  try {
    await layer.seek(options.time ?? layer.times[0]);
    return layer;
  } catch (error) {
    figure.remove(layer);
    throw error;
  }
}
