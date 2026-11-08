// NRRD volumes straight into a figure: fetch or take the bytes of a `.nrrd` or detached `.nhdr` file, read it with
// `parseNRRD` of `@margoengine/loaders/nrrd` (Teem, "Definition of NRRD File Format"), pick one volume of a time
// series and one sample of a multi-component voxel, and draw it with `fig.volume()` in the file's true proportions.
import { parseNRRD, type NRRDData, type NRRDVolume } from '@margoengine/loaders/nrrd';
import { rangeError, typeError } from '../../shared/errors.js';
import type { Bounds } from './layer.js';
import type { VolumeLayer, VolumeLayerOptions } from './volume.js';
import type { Figure } from './figure.js';

export type { NRRDVolume, NRRDData, NRRDType } from '@margoengine/loaders/nrrd';

/** Where a NRRD file comes from: a URL to fetch, or the file's bytes. */
export type NRRDSource = string | URL | ArrayBuffer | ArrayBufferView;

/** Options of {@link loadNRRD}. */
export interface LoadNRRDOptions {
  /**
   * Reads a detached `data file` by the path the header writes. Default: fetched relative to the header's URL when
   * `source` is a URL; none for bytes, so a `.nhdr` given as bytes needs this.
   */
  readonly resolve?: (path: string) => Promise<Uint8Array | string>;
  /** Maximum samples in the whole file. Default 536,870,912. */
  readonly maxSamples?: number;
  /** Request options for every fetch (headers, credentials). Default none. */
  readonly init?: RequestInit;
  readonly signal?: AbortSignal;
}

/** Options of {@link nrrdGrid} and {@link volumeFromNRRD}: which volume and which sample per voxel. */
export interface NRRDGridOptions {
  /** Volume of a time series (or any axes after the spatial ones), from 0. Default 0. */
  readonly frame?: number;
  /** Sample of a multi-component voxel, from 0, or `'magnitude'` for the length of the vector. Default 0. */
  readonly component?: number | 'magnitude';
}

/** One scalar grid of a NRRD file, in the shape `fig.volume()`, `fig.isosurface()` and slices take. */
export interface NRRDGrid {
  /** `nx * ny * nz` samples, x fastest. The file's own type for one scalar volume, else `Float32Array`. */
  readonly data: NRRDData;
  readonly dims: [number, number, number];
  /** Box in the file's true proportions, from 0, in `spacing` units. */
  readonly bounds: Bounds;
  /** Smallest and largest finite sample. */
  readonly range: [number, number];
}

async function fetchBytes(url: URL, options: LoadNRRDOptions): Promise<Uint8Array> {
  const response = await fetch(url, { ...options.init, signal: options.signal });
  if (!response.ok) throw rangeError(`NRRD fetch of ${url.href} answered ${response.status}`, 'sciviz');
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Reads a NRRD volume from a URL or from bytes. A URL's detached data files are fetched next to it. Rejects with the
 * loader's coded errors for a damaged or unsupported file, and with `AbortError` when `signal` aborts.
 */
export async function loadNRRD(source: NRRDSource, options: LoadNRRDOptions = {}): Promise<NRRDVolume> {
  if (typeof source === 'string' || source instanceof URL) {
    const url = new URL(source, globalThis.location?.href);
    const bytes = await fetchBytes(url, options);
    return parseNRRD(bytes, {
      resolve: options.resolve ?? ((path) => fetchBytes(new URL(path, url), options)),
      maxSamples: options.maxSamples,
      signal: options.signal,
    });
  }
  if (!(source instanceof ArrayBuffer) && !ArrayBuffer.isView(source))
    throw typeError('loadNRRD takes a URL, an ArrayBuffer or a typed array', 'sciviz');
  return parseNRRD(source, { resolve: options.resolve, maxSamples: options.maxSamples, signal: options.signal });
}

/** Picks one scalar grid out of a NRRD volume: a frame of a series and a component (or the magnitude) per voxel. */
export function nrrdGrid(volume: NRRDVolume, options: NRRDGridOptions = {}): NRRDGrid {
  const frame = options.frame ?? 0,
    component = options.component ?? 0,
    { components, frames, dims } = volume;
  if (!Number.isInteger(frame) || frame < 0 || frame >= frames)
    throw rangeError(`NRRD frame ${frame} is outside the file's ${frames} volume(s)`, 'sciviz');
  if (component !== 'magnitude' && (!Number.isInteger(component) || component < 0 || component >= components))
    throw rangeError(`NRRD component ${String(component)} is outside the file's ${components} per voxel`, 'sciviz');
  const voxels = dims[0] * dims[1] * dims[2],
    start = frame * voxels * components;
  let data: NRRDData;
  if (components === 1 && frames === 1) data = volume.data;
  else if (components === 1) data = volume.data.subarray(start, start + voxels) as NRRDData;
  else {
    const out = new Float32Array(voxels),
      source = volume.data;
    for (let v = 0; v < voxels; v++) {
      const at = start + v * components;
      if (component === 'magnitude') {
        let sum = 0;
        for (let c = 0; c < components; c++) sum += source[at + c] * source[at + c];
        out[v] = Math.sqrt(sum);
      } else out[v] = source[at + component];
    }
    data = out;
  }
  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    // Infinite samples (ascii "inf" is one) and NaN stay out of the range, which is the finite extent.
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!(min <= max)) min = max = 0;
  return { data, dims: [...dims], bounds: [...volume.bounds], range: [min, max] };
}

/**
 * Reads a NRRD file and draws it as a volume in `figure`, in the file's true proportions, with the colour range
 * spanning its samples unless `range` says otherwise. Resolves to the layer and the file it came from.
 */
export async function volumeFromNRRD(
  figure: Figure,
  source: NRRDSource,
  options: LoadNRRDOptions & NRRDGridOptions & VolumeLayerOptions = {},
): Promise<{ layer: VolumeLayer; volume: NRRDVolume; grid: NRRDGrid }> {
  const volume = await loadNRRD(source, options),
    grid = nrrdGrid(volume, options);
  options.signal?.throwIfAborted();
  const layer = figure.volume(grid.data, {
    ...options,
    dims: grid.dims,
    bounds: options.bounds ?? grid.bounds,
    range: options.range ?? (grid.range[0] < grid.range[1] ? grid.range : undefined),
  });
  return { layer, volume, grid };
}
