/// <reference lib="esnext.disposable" preserve="true" />
import type { Figure } from './figure.js';
import type { Bounds } from './layer.js';
import type { Timeline, TimelineOptions } from './timeline.js';
import { fault, rangeError } from '../../shared/errors.js';
import { geoVectorLayer, parseGeoVectors, type GeoVectorLayer, type GeoVectorOptions } from './geo-vector.js';
import {
  prepareGeoTrack,
  geoPositionAt,
  geoTrail,
  type GeoTrack,
  type GeoTrackData,
  type GeoInterpolation,
} from './geo-time-data.js';
import { SGP4, satelliteGeodetic } from './geo-sgp4.js';

/** Trajectory/trip styling and time sampling. */
export interface GeoTripsOptions
  extends Pick<
    GeoVectorOptions,
    | 'projection'
    | 'height'
    | 'radius'
    | 'width'
    | 'color'
    | 'lineColor'
    | 'maxDegrees'
    | 'maxOutputVertices'
    | 'attribution'
  > {
  /** Trail duration in track time units, default 600. Zero draws current positions only. */
  readonly trail?: number;
  /** Opacity buckets for fading trails, default 16; 1 disables fading. Range 1..64. */
  readonly fadeSteps?: number;
  /** Default linear with shortest-path longitude interpolation. */
  readonly interpolation?: GeoInterpolation;
  /** Time shown initially. Default first key across all tracks. */
  readonly time?: number;
  readonly signal?: AbortSignal;
}
/** An owned group of retained geographic primitives with serialized, transactional seeks. */
export class GeoTripsLayer {
  readonly tracks: readonly GeoTrackData[];
  readonly #figure: Figure;
  readonly #options: GeoTripsOptions;
  readonly #lifetime = new AbortController();
  readonly #abort = () => this.dispose();
  #layers: GeoVectorLayer[] = [];
  #queue: Promise<void> = Promise.resolve();
  #time = NaN;
  #visible = true;
  #disposed = false;
  #timeline?: Timeline;
  /** @internal Use geoTripsLayer. */
  constructor(figure: Figure, tracks: readonly GeoTrack[], options: GeoTripsOptions) {
    options.signal?.throwIfAborted();
    const steps = options.fadeSteps ?? 16,
      duration = options.trail ?? 600;
    if (
      !Number.isFinite(duration) ||
      duration < 0 ||
      !Number.isInteger(steps) ||
      steps < 1 ||
      steps > 64 ||
      !tracks.length
    )
      throw rangeError('Trips need tracks, nonnegative finite trail duration and fadeSteps 1..64', 'sciviz');
    this.#figure = figure;
    this.#options = options;
    this.tracks = tracks.map(prepareGeoTrack);
    const ids = new Set(this.tracks.map((t) => t.id));
    if (ids.size !== tracks.length) throw rangeError('Trip IDs must be unique', 'sciviz');
    // Validate the interpolation mode even before the first visible key.
    geoPositionAt(this.tracks[0], this.tracks[0].times[0], { interpolation: options.interpolation });
    options.signal?.addEventListener('abort', this.#abort, { once: true });
  }
  get time(): number {
    return this.#time;
  }
  /** @internal Children receive the figure's same transform directly. */
  setModel(_model: Float32Array): void {}
  get visible(): boolean {
    return this.#visible;
  }
  set visible(value: boolean) {
    this.#visible = value;
    for (const layer of this.#layers) layer.visible = value;
  }
  get bounds(): Bounds {
    if (!this.#layers.length)
      return this.#options.projection === 'globe' ? [-1, 1, -1, 1, -1, 1] : [-1, 1, -1, 1, -0.01, 0.01];
    const boxes = this.#layers.map((layer) => layer.bounds);
    return Array.from({ length: 6 }, (_, i) =>
      i % 2 ? Math.max(...boxes.map((b) => b[i])) : Math.min(...boxes.map((b) => b[i])),
    ) as Bounds;
  }
  /** Resolve after all replacement primitives are ready. Old primitives survive a failed seek. */
  seek(time: number, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (!Number.isFinite(time)) return Promise.reject(rangeError('Trip time must be finite', 'sciviz'));
    const run = this.#queue.then(async () => {
      if (this.#disposed) throw fault('disposed', 'Trips layer disposed; create a new layer', 'sciviz');
      const signal = options.signal ? AbortSignal.any([this.#lifetime.signal, options.signal]) : this.#lifetime.signal;
      signal.throwIfAborted();
      const next: GeoVectorLayer[] = [],
        duration = this.#options.trail ?? 600,
        steps = this.#options.fadeSteps ?? 16;
      const make = async (features: object[], opacity: number, point: boolean) => {
        if (!features.length) return;
        const source = await parseGeoVectors({ type: 'FeatureCollection', features }, { signal });
        const layer = await geoVectorLayer(this.#figure, source, {
          ...this.#options,
          signal: this.#lifetime.signal,
          fill: false,
          opacity,
          width: point ? 0 : (this.#options.width ?? 3),
          radius: point ? (this.#options.radius ?? 5) : 0,
        });
        layer.visible = false;
        next.push(layer);
      };
      try {
        if (duration > 0)
          for (let bucket = 0; bucket < steps; bucket++) {
            const start = time - duration + (duration * bucket) / steps,
              end = time - duration + (duration * (bucket + 1)) / steps,
              features = this.tracks.flatMap((track) => {
                const segment = geoTrail(track, end, end - start, { interpolation: this.#options.interpolation });
                return segment && segment.times.length > 1
                  ? [
                      {
                        type: 'Feature',
                        id: track.id,
                        properties: track.properties ?? {},
                        geometry: {
                          type: 'LineString',
                          coordinates: Array.from({ length: segment.times.length }, (_, i) =>
                            Array.from(segment.positions.slice(i * 3, i * 3 + 3)),
                          ),
                        },
                      },
                    ]
                  : [];
              });
            await make(features, steps === 1 ? 1 : (bucket + 0.5) / steps, false);
          }
        const heads = this.tracks.flatMap((track) => {
          const position = geoPositionAt(track, time, { interpolation: this.#options.interpolation });
          return position
            ? [
                {
                  type: 'Feature',
                  id: track.id,
                  properties: track.properties ?? {},
                  geometry: { type: 'Point', coordinates: position },
                },
              ]
            : [];
        });
        await make(heads, 1, true);
        signal.throwIfAborted();
        for (const old of this.#layers) this.#figure.remove(old);
        this.#layers = next;
        this.#time = time;
        for (const layer of next) layer.visible = this.#visible;
      } catch (error) {
        for (const layer of next) this.#figure.remove(layer);
        throw error;
      }
    });
    this.#queue = run.catch(() => {});
    return run;
  }
  /** Figure-owned playback, awaits each seek. Times use the same units as track keys. */
  timeline(times: ArrayLike<number>, options: TimelineOptions = {}): Timeline {
    if (this.#disposed) throw fault('disposed', 'Trips layer disposed; create a new layer', 'sciviz');
    return (this.#timeline = this.#figure.timeline(times, (_, time) => this.seek(time), options));
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifetime.abort();
    this.#timeline?.dispose();
    this.#options.signal?.removeEventListener('abort', this.#abort);
    for (const layer of this.#layers) this.#figure.remove(layer);
    this.#layers = [];
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Attach trajectories, moving heads, age-faded trails and keyframed positions to a map or globe. */
export async function geoTripsLayer(
  figure: Figure,
  tracks: readonly GeoTrack[],
  options: GeoTripsOptions = {},
): Promise<GeoTripsLayer> {
  const layer = new GeoTripsLayer(figure, tracks, options);
  try {
    await layer.seek(options.time ?? Math.min(...layer.tracks.map((t) => t.times[0])));
    return figure.addLayer(layer);
  } catch (error) {
    layer.dispose();
    throw error;
  }
}
/** Sample a satellite ground track or its altitude path at UTC Unix-millisecond keys. */
export function satelliteTrack(
  satellite: SGP4,
  times: ArrayLike<number>,
  options: { readonly ground?: boolean; readonly signal?: AbortSignal } = {},
): GeoTrackData {
  const positions = new Float64Array(times.length * 3);
  for (let i = 0; i < times.length; i++) {
    options.signal?.throwIfAborted();
    const p = satelliteGeodetic(satellite.at(times[i]));
    if (options.ground ?? true) p[2] = 0;
    positions.set(p, i * 3);
  }
  return prepareGeoTrack({
    id: satellite.elements.id,
    times,
    positions,
    properties: { name: satellite.elements.name ?? satellite.elements.id },
  });
}
