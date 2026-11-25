// Mean sea level above the WGS84 ellipsoid (the geoid undulation N) from the EGM96 15-minute grid of the US National
// Geospatial-Intelligence Agency (public domain): 721 x 1441 heights packed as little-endian int16 centimetres
// (2,077,922 bytes, egm96-15.bin), read lazily from beside this entry, looked up bilinearly. Optional entry: the
// geospatial camera imports it only when a sea-level height is first asked for.
import { fault, rangeError } from '../../shared/errors.js';

/** The packed grid file's name; `scripts/geoid/pack-egm96.mjs` writes it into `packages/controls/data`. */
export const EGM96_FILE = 'egm96-15.bin';
/** Rows (90 N to 90 S) and columns (0 to 360 E, both ends kept) of the 15-minute EGM96 grid. */
export const EGM96_ROWS = 721;
export const EGM96_COLUMNS = 1441;

/** A regular latitude-longitude grid of geoid heights. Angles in degrees, rows north to south, columns west to east. */
export interface GeoidGrid {
  /** Heights, row by row from the north edge, `rows * columns` values times `scale` metres. */
  readonly data: Int16Array | Float32Array | Float64Array;
  readonly rows: number;
  readonly columns: number;
  /** Latitude of the first row, degrees. Default 90. */
  readonly north?: number;
  /** Longitude of the first column, degrees. Default 0. */
  readonly west?: number;
  /** Grid spacing, degrees, both ways. Default 0.25 (15 minutes). */
  readonly step?: number;
  /** Metres per stored unit. Default 0.01 (centimetres). */
  readonly scale?: number;
}

/** Geoid heights over a grid: {@link Geoid.undulation} in RADIANS, metres out. */
export class Geoid {
  private readonly g: Required<GeoidGrid>;
  constructor(grid: GeoidGrid) {
    const g = { north: 90, west: 0, step: 0.25, scale: 0.01, ...grid };
    if (
      !(Number.isInteger(g.rows) && Number.isInteger(g.columns) && g.rows >= 2 && g.columns >= 2) ||
      g.data?.length !== g.rows * g.columns ||
      ![g.north, g.west, g.step, g.scale].every(Number.isFinite) ||
      !(g.step > 0 && g.scale > 0)
    )
      throw rangeError(
        'A geoid grid needs rows * columns heights, rows and columns of 2 or more and a finite step and scale above 0; pass the packed EGM96 grid',
        'controls-geoid',
      );
    this.g = g;
  }
  /**
   * Geoid height above the WGS84 ellipsoid at longitude and latitude in RADIANS, metres, bilinear between the four
   * nearest grid heights. Longitude wraps; latitudes outside the grid clamp to its edge rows.
   */
  undulation(longitude: number, latitude: number): number {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return Number.NaN;
    const g = this.g,
      lat = (latitude * 180) / Math.PI,
      lon = (longitude * 180) / Math.PI,
      // A full turn of columns wraps; a smaller patch clamps at its edges like the rows.
      turn = Math.abs((g.columns - 1) * g.step - 360) < 1e-9,
      y = Math.min(g.rows - 1, Math.max(0, (g.north - lat) / g.step)),
      rawX = (lon - g.west) / g.step,
      x = turn
        ? ((rawX % (g.columns - 1)) + (g.columns - 1)) % (g.columns - 1)
        : Math.min(g.columns - 1, Math.max(0, rawX)),
      r = Math.min(g.rows - 2, Math.floor(y)),
      c = Math.min(g.columns - 2, Math.floor(x)),
      fy = y - r,
      fx = x - c,
      d = g.data,
      at = (i: number, j: number) => d[i * g.columns + j]!;
    return (
      g.scale *
      ((1 - fy) * ((1 - fx) * at(r, c) + fx * at(r, c + 1)) + fy * ((1 - fx) * at(r + 1, c) + fx * at(r + 1, c + 1)))
    );
  }
  /** The same as a `(longitude, latitude) => metres` function, for `GeospatialControls`' `geoid` option. */
  get query(): (longitude: number, latitude: number) => number {
    return (longitude, latitude) => this.undulation(longitude, latitude);
  }
}

/**
 * Quantise geoid heights in metres to int16 units of `scale` metres (default centimetres), rounding to nearest: what
 * `scripts/geoid/pack-egm96.mjs` writes. EGM96 spans -107 to +86 m, well inside int16 centimetres (+-327 m).
 */
export function packGeoid(metres: ArrayLike<number>, scale = 0.01): Int16Array {
  if (!(scale > 0 && Number.isFinite(scale)))
    throw rangeError('packGeoid needs a finite scale above 0; pass 0.01 for centimetres', 'controls-geoid');
  const out = new Int16Array(metres.length);
  for (let i = 0; i < metres.length; i++) {
    const v = Math.round(metres[i]! / scale);
    if (!(v >= -32768 && v <= 32767))
      throw rangeError(
        `packGeoid: height ${metres[i]} m at ${i} does not fit int16 at this scale; pass a coarser scale`,
        'controls-geoid',
      );
    out[i] = v;
  }
  return out;
}

/** Options of {@link loadEGM96}. */
export interface LoadGeoidOptions {
  /** Where the packed grid is. Default `egm96-15.bin` beside this entry. */
  url?: string | URL;
  /** Stops the download; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Load the packed EGM96 15-minute grid (2,077,922 bytes) and return its {@link Geoid}. Rejects with a MargoError of
 * code `failed` when the file is missing or the wrong size, naming how to make it.
 */
export async function loadEGM96(options: LoadGeoidOptions = {}): Promise<Geoid> {
  const url = new URL(options.url ?? /* @vite-ignore */ `./${EGM96_FILE}`, import.meta.url),
    bytes = await read(url, options.signal),
    size = EGM96_ROWS * EGM96_COLUMNS * 2;
  if (!bytes || bytes.byteLength !== size)
    throw fault(
      'failed',
      `The EGM96 grid ${url.href} is ${bytes ? `${bytes.byteLength} bytes, not ${size}` : 'missing'}; build it with node scripts/geoid/pack-egm96.mjs from NGA's WW15MGH.GRD`,
      'controls-geoid',
    );
  const view = new DataView(bytes),
    data = new Int16Array(EGM96_ROWS * EGM96_COLUMNS);
  for (let i = 0; i < data.length; i++) data[i] = view.getInt16(i * 2, true);
  return new Geoid({ data, rows: EGM96_ROWS, columns: EGM96_COLUMNS });
}

/** The file's bytes, or null when it is not there (fetch in a page, the file system for a file: URL in Node). */
async function read(url: URL, signal?: AbortSignal): Promise<ArrayBuffer | null> {
  signal?.throwIfAborted();
  if (url.protocol === 'file:') {
    const fs = 'node:fs/promises',
      { readFile } = (await import(/* @vite-ignore */ fs)) as {
        readFile(path: URL, options: object): Promise<Uint8Array>;
      };
    try {
      const b = await readFile(url, signal ? { signal } : {});
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }
  const response = await fetch(url, signal ? { signal } : {});
  if (response.status === 404) return null;
  if (!response.ok)
    throw fault(
      'failed',
      `The EGM96 grid ${url.href} answered HTTP ${response.status}; serve the file beside the entry`,
      'controls-geoid',
    );
  return response.arrayBuffer();
}
