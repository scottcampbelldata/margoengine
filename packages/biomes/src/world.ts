/// <reference lib="esnext.disposable" preserve="true" />
// BiomeWorld: a finite world (decision D1, up to 64 km) of tiles with climate fields, built on the CPU in integers.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { type Climate, type ClimateOptions, quantizeClimate } from './climate.js';
import { tileFields } from './fields.js';
import { divFloor, imod } from './fixed.js';
import { type Heights, type HeightSource, heightsOf } from './height.js';
import { canonicalBytes, DEFAULT_LAYERS, LAYERS, type RasterLayer, sha256 } from './layers.js';
import { buildRegion, type Region } from './region.js';
import { type BiomeSample, readCell, samplePoint } from './sample.js';

/** Settings of {@link BiomeWorld.create}. Every option has a default; `BiomeWorld.create()` makes a working world. */
export interface BiomeWorldOptions {
  /** u32 seed. Default 1. */
  readonly seed?: number;
  /** Heights. Default: a seeded procedural landscape over the world (`{ relief: {} }`). */
  readonly height?: HeightSource;
  /** World XZ of the minimum corner in metres. Default: centred on the origin, `-size / 2`. */
  readonly origin?: readonly [number, number];
  /** World extent [x, z] in metres, each a multiple of `regionResolution`, 256..65,536. Default [4096, 4096]. */
  readonly size?: readonly [number, number];
  /** Climate settings. Default: latitude 45, 900 mm of rain, westerly wind. */
  readonly climate?: ClimateOptions;
  /** Tile side in metres. Default 256. */
  readonly tileSize?: 128 | 256 | 512;
  /** Tile cell size in metres. Default 1. */
  readonly resolution?: 0.5 | 1 | 2 | 4;
  /** Region cell size in metres, a power of two from 4 x `resolution` up to `tileSize`. Default 16. */
  readonly regionResolution?: number;
  /** `'auto'` and `'cpu'` compute on the CPU; `'gpu'` is not available yet and throws. Output is identical either way.
   * Default `'auto'`. */
  readonly backend?: 'auto' | 'gpu' | 'cpu';
  /** Rejects `create` with the signal's reason when aborted. */
  readonly signal?: AbortSignal;
}

/** Options of a tile request. */
export interface TileRequest {
  /** Layers to compute. Default: every layer in `DEFAULT_LAYERS`; `'profile'` and `'plan'` only when named. */
  readonly layers?: readonly string[];
  /** Rejects with the signal's reason when aborted before the tile is made; the cache stays consistent. */
  readonly signal?: AbortSignal;
}

/** One tile of a biome world: its layers, row-major, `cells` x `cells`. */
export interface BiomeTile {
  /** Tile column and row (tile indices; tile (0, 0) starts at the world's minimum corner). */
  readonly x: number;
  readonly z: number;
  /** World XZ of the tile's first cell in metres. */
  readonly origin: readonly [number, number];
  /** Cells per side and cell size in metres. */
  readonly cells: number;
  readonly resolution: number;
  /** Names of the layers this tile holds. */
  readonly layers: readonly string[];
  /** A layer by name, or undefined when the tile does not hold it. */
  layer(name: string): RasterLayer | undefined;
}

const TILE_SIZES = [128, 256, 512],
  RESOLUTIONS = [0.5, 1, 2, 4],
  BACKENDS = ['auto', 'gpu', 'cpu'];
/** Most tiles kept in the cache before the oldest is dropped (the streaming cache with a memory cap arrives in B7). */
const CACHE = 256;

type Rect = readonly [number, number, number, number];

const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason;
};

/**
 * A biome world: climate fields over a finite heightmap, as tiles. Everything that decides the output is integer
 * arithmetic, so the same options give byte-identical tiles everywhere (`digest` proves it).
 * `using world = await BiomeWorld.create()` frees it at the end of a block.
 * @example
 * const world = await BiomeWorld.create({ seed: 7, climate: { latitude: 60 } });
 * const tile = await world.tile(0, 0);
 * const celsius = tile.layer('temperature')!.data[0] * 0.01;
 */
export class BiomeWorld implements Disposable {
  /** u32 seed. */
  readonly seed: number;
  /** Tile side in metres. */
  readonly tileSize: number;
  /** Tile cell size in metres. */
  readonly resolution: number;
  /** Region cell size in metres. */
  readonly regionResolution: number;
  /** World rectangle `[minX, minZ, maxX, maxZ]` in metres. */
  readonly bounds: Rect;
  /** Tiles along x and z. */
  readonly tilesX: number;
  readonly tilesZ: number;
  #climate: Climate;
  #region: Region;
  #heights: Heights;
  readonly #origin: readonly [number, number]; // mm
  readonly #size: readonly [number, number]; // mm
  readonly #cache = new Map<string, Promise<BiomeTile>>();
  /** Finished tiles that hold every default layer, for exact `sample` reads. */
  readonly #ready = new Map<string, BiomeTile>();
  readonly #listeners = new Set<(rect: Rect) => void>();
  #notifying = false;
  #disposed = false;

  private constructor(options: BiomeWorldOptions) {
    const seed = options.seed ?? 1,
      size = options.size ?? [4096, 4096],
      tileSize = options.tileSize ?? 256,
      resolution = options.resolution ?? 1,
      regionResolution = options.regionResolution ?? 16,
      backend = options.backend ?? 'auto';
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
      throw rangeError('BiomeWorld seed must be an integer in 0..2^32-1', 'biomes');
    if (!TILE_SIZES.includes(tileSize)) throw rangeError('BiomeWorld tileSize must be 128, 256 or 512', 'biomes');
    if (!RESOLUTIONS.includes(resolution)) throw rangeError('BiomeWorld resolution must be 0.5, 1, 2 or 4', 'biomes');
    if (
      !Number.isInteger(regionResolution) ||
      regionResolution < 4 * resolution ||
      regionResolution > tileSize ||
      (regionResolution & (regionResolution - 1)) !== 0
    )
      throw rangeError(
        'BiomeWorld regionResolution must be a power of two from 4 x resolution up to tileSize',
        'biomes',
      );
    if (
      !Array.isArray(size) ||
      size.length !== 2 ||
      !size.every((v) => Number.isInteger(v) && v >= 256 && v <= 65536 && imod(v, regionResolution) === 0)
    )
      throw rangeError(
        'BiomeWorld size must be [x, z] in metres, 256..65,536, multiples of regionResolution',
        'biomes',
      );
    const origin = options.origin ?? [-size[0] / 2, -size[1] / 2];
    if (!Array.isArray(origin) || origin.length !== 2 || !origin.every((v) => Number.isFinite(v) && Math.abs(v) <= 1e6))
      throw rangeError('BiomeWorld origin must be [x, z] in metres within 1,000 km', 'biomes');
    if (!BACKENDS.includes(backend)) throw rangeError("BiomeWorld backend must be 'auto', 'gpu' or 'cpu'", 'biomes');
    if (backend === 'gpu')
      throw fault('unsupported', "The biomes GPU backend is not available yet; use backend 'auto' or 'cpu'", 'biomes');
    this.seed = seed >>> 0;
    this.tileSize = tileSize;
    this.resolution = resolution;
    this.regionResolution = regionResolution;
    this.#origin = [Math.round(origin[0] * 1000), Math.round(origin[1] * 1000)];
    this.#size = [size[0] * 1000, size[1] * 1000];
    this.bounds = Object.freeze([origin[0], origin[1], origin[0] + size[0], origin[1] + size[1]] as const);
    this.tilesX = -divFloor(-size[0], tileSize);
    this.tilesZ = -divFloor(-size[1], tileSize);
    this.#climate = quantizeClimate(options.climate);
    this.#heights = heightsOf(options.height, this.#origin, this.#size, this.seed);
    this.#region = this.#buildRegion();
  }

  /**
   * Makes a world: validates the options, samples the region heights and builds the region fields (on this thread).
   * @throws TypeError or RangeError for bad options; MargoError `'unsupported'` for `backend: 'gpu'`.
   */
  static async create(options: BiomeWorldOptions = {}): Promise<BiomeWorld> {
    if (typeof options !== 'object' || options === null)
      throw typeError('BiomeWorld options must be an object; pass {} for the defaults', 'biomes');
    aborted(options.signal);
    await Promise.resolve();
    aborted(options.signal);
    return new BiomeWorld(options);
  }

  #buildRegion(): Region {
    const step = this.regionResolution * 1000,
      nx = divFloor(this.#size[0], step) + 1,
      nz = divFloor(this.#size[1], step) + 1,
      height = this.#heights.grid(0, 0, nx, nz, step),
      water = this.#heights.relief ? riverCells(this.#heights.relief.rivers, this.#origin, step, nx, nz) : undefined;
    return buildRegion(height, nx, nz, step, this.#climate, water);
  }

  #live(): void {
    if (this.#disposed)
      throw fault('disposed', 'BiomeWorld is disposed; create a new one with BiomeWorld.create()', 'biomes');
  }

  /** The climate settings in force, quantised. */
  get climate(): Climate {
    return this.#climate;
  }

  /**
   * One tile's layers, cached. `x` and `z` are tile indices, 0..tilesX - 1 and 0..tilesZ - 1.
   * @throws RangeError for a tile outside the world; MargoError `'disposed'` after dispose. Rejects with the signal's
   * reason when aborted.
   */
  async tile(x: number, z: number, options: TileRequest = {}): Promise<BiomeTile> {
    this.#live();
    if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || z < 0 || x >= this.tilesX || z >= this.tilesZ)
      throw rangeError(
        'BiomeWorld tile indices must be integers inside the world (0..tilesX - 1, 0..tilesZ - 1)',
        'biomes',
      );
    const names = options.layers ?? DEFAULT_LAYERS;
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string' && name in LAYERS))
      throw rangeError('Unknown biome layer name; use names from LAYERS', 'biomes');
    aborted(options.signal);
    const key = `${x},${z}:${[...names].sort().join(',')}`;
    let pending = this.#cache.get(key);
    if (!pending) {
      pending = this.#make(x, z, names);
      this.#cache.set(key, pending);
      if (this.#cache.size > CACHE) {
        const oldest = this.#cache.keys().next().value!;
        this.#cache.delete(oldest);
        this.#ready.delete(oldest.slice(0, oldest.indexOf(':')));
      }
      pending.then(
        (tile) => {
          if (this.#cache.get(key) === pending && DEFAULT_LAYERS.every((name) => tile.layers.includes(name)))
            this.#ready.set(`${x},${z}`, tile);
        },
        () => this.#cache.delete(key),
      );
    }
    const tile = await pending;
    aborted(options.signal);
    return tile;
  }

  async #make(x: number, z: number, names: readonly string[]): Promise<BiomeTile> {
    await Promise.resolve();
    this.#live();
    const cells = (this.tileSize * 2) / (this.resolution * 2), // float division: 128..1024, exact
      layers = tileFields(
        { climate: this.#climate, region: this.#region, heights: this.#heights, cell: this.resolution * 1000, cells },
        x,
        z,
        names,
      ),
      list = Object.keys(LAYERS).filter((name) => layers.has(name));
    return Object.freeze({
      x,
      z,
      origin: Object.freeze([this.bounds[0] + x * this.tileSize, this.bounds[1] + z * this.tileSize] as const),
      cells,
      resolution: this.resolution,
      layers: Object.freeze(list),
      layer: (name: string) => layers.get(name),
    });
  }

  /**
   * The tiles overlapping a world rectangle `[minX, minZ, maxX, maxZ]` (metres), nearest to `focus` first (default:
   * the rectangle's centre), as they finish.
   */
  async *tiles(
    rect: Rect,
    options: TileRequest & { readonly focus?: readonly [number, number] } = {},
  ): AsyncIterableIterator<BiomeTile> {
    this.#live();
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite))
      throw typeError('BiomeWorld tiles takes a [minX, minZ, maxX, maxZ] rectangle in metres', 'biomes');
    const [x0, z0, x1, z1] = this.#tileRange(rect),
      focus = options.focus ?? [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2],
      order: [number, number, number][] = [];
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const cx = this.bounds[0] + (x + 0.5) * this.tileSize - focus[0],
          cz = this.bounds[1] + (z + 0.5) * this.tileSize - focus[1];
        order.push([cx * cx + cz * cz, x, z]);
      }
    order.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
    for (const [, x, z] of order) yield await this.tile(x, z, options);
  }

  /** Tile index range `[x0, z0, x1, z1]` (inclusive) overlapping a world rectangle, clamped to the world. */
  #tileRange(rect: Rect): [number, number, number, number] {
    const t = this.tileSize,
      clampX = (v: number) => Math.min(this.tilesX - 1, Math.max(0, v)),
      clampZ = (v: number) => Math.min(this.tilesZ - 1, Math.max(0, v));
    return [
      clampX(Math.floor((rect[0] - this.bounds[0]) / t)), // float division: metres to tile indices
      clampZ(Math.floor((rect[1] - this.bounds[1]) / t)), // float division
      clampX(Math.ceil((rect[2] - this.bounds[0]) / t) - 1), // float division
      clampZ(Math.ceil((rect[3] - this.bounds[1]) / t) - 1), // float division
    ];
  }

  /**
   * Point query for gameplay: climate values at world (x, z) in metres, synchronous. Exact (the tile's own cell) when
   * the tile is cached; otherwise from the region fields, which can differ slightly near sharp terrain.
   */
  sample(x: number, z: number, out?: BiomeSample): BiomeSample {
    this.#live();
    if (!Number.isFinite(x) || !Number.isFinite(z))
      throw rangeError('BiomeWorld sample needs finite x and z', 'biomes');
    const gx = Math.floor((x - this.bounds[0]) / this.resolution), // float division: metres to cells
      gz = Math.floor((z - this.bounds[1]) / this.resolution), // float division
      cells = this.tileSize / this.resolution, // float division: exact
      tile = this.#ready.get(`${Math.floor(gx / cells)},${Math.floor(gz / cells)}`); // float division
    if (tile) return readCell(tile, gx - tile.x * cells, gz - tile.z * cells, out);
    return samplePoint(this.#climate, this.#region, this.#origin, x, z, out);
  }

  /**
   * Replaces the climate or the heights; every tile is recomputed on its next request and listeners get the world
   * rectangle. Height edits change fields far downwind (rain shadow) and downstream, so the whole world is dirty.
   * @throws MargoError `'state'` when called from inside an `onChange` listener.
   */
  update(changes: { readonly climate?: ClimateOptions; readonly height?: HeightSource }): void {
    this.#live();
    if (this.#notifying)
      throw fault(
        'state',
        'BiomeWorld update called from an onChange listener; update after the listener returns',
        'biomes',
      );
    if (typeof changes !== 'object' || changes === null)
      throw typeError('BiomeWorld update takes { climate?, height? }', 'biomes');
    if (changes.climate) this.#climate = quantizeClimate(changes.climate);
    if (changes.height) this.#replaceHeights(changes.height);
    if (changes.climate || changes.height) this.#region = this.#buildRegion();
    this.#cache.clear();
    this.#ready.clear();
    this.#emit(this.bounds);
  }

  #replaceHeights(source: HeightSource): void {
    this.#heights = heightsOf(source, this.#origin, this.#size, this.seed);
  }

  #emit(rect: Rect): void {
    this.#notifying = true;
    try {
      for (const listener of [...this.#listeners]) listener(rect);
    } finally {
      this.#notifying = false;
    }
  }

  /** Calls `listener` with each dirty rectangle `[minX, minZ, maxX, maxZ]` (metres); returns an unsubscribe function. */
  onChange(listener: (rect: Rect) => void): () => void {
    this.#live();
    if (typeof listener !== 'function') throw typeError('BiomeWorld onChange takes a function', 'biomes');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * SHA-256 (hex) of the canonical bytes of a tile's default layers: name, format, size and little-endian data per
   * layer, in `LAYERS` order. The same options give the same digest on every machine.
   */
  async digest(x: number, z: number, options: { readonly signal?: AbortSignal } = {}): Promise<string> {
    const tile = await this.tile(x, z, { signal: options.signal });
    return sha256(canonicalBytes(tile.layers.map((name) => tile.layer(name)!)));
  }

  /** Frees the cache and listeners; later calls throw MargoError `'disposed'`. */
  dispose(): void {
    this.#disposed = true;
    this.#cache.clear();
    this.#ready.clear();
    this.#listeners.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Region cells along river centre lines (within half a cell), as water sources. */
function riverCells(
  rivers: readonly Int32Array[],
  origin: readonly [number, number],
  step: number,
  nx: number,
  nz: number,
): Uint8Array {
  const mask = new Uint8Array(nx * nz);
  for (const line of rivers)
    for (let k = 0; k + 3 < line.length; k += 2) {
      const ax = line[k] - origin[0],
        az = line[k + 1] - origin[1],
        bx = line[k + 2] - origin[0],
        bz = line[k + 3] - origin[1],
        n = Math.max(1, divFloor(2 * Math.max(Math.abs(bx - ax), Math.abs(bz - az)), step));
      for (let s = 0; s <= n; s++) {
        const x = divFloor(2 * (ax + divFloor((bx - ax) * s, n)) + step, 2 * step),
          z = divFloor(2 * (az + divFloor((bz - az) * s, n)) + step, 2 * step);
        if (x >= 0 && z >= 0 && x < nx && z < nz) mask[z * nx + x] = 1;
      }
    }
  return mask;
}
