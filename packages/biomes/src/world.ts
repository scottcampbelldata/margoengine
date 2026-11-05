/// <reference lib="esnext.disposable" preserve="true" />
// BiomeWorld: a finite world (decision D1, up to 64 km) of tiles with integer climate fields.
import { worldGPU } from './gpu-placement-flow-internal.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { type Climate, type ClimateOptions, quantizeClimate } from './climate.js';
import { assemble, classified, wideNames } from './assemble.js';
import {
  type ClassifyInput,
  checkPaint,
  type Classifier,
  classifier,
  classify,
  type PaintLayer,
  type ZoneClassifier,
} from './classify.js';
import { type BiomeDefinition, defineBiome } from './define.js';
import { rectFields, type TileFrame } from './fields.js';
import { divFloor, imod } from './fixed.js';
import type { GpuTiles } from './gpu.js';
import type { Heights, HeightSource } from './height.js';
import { DEFAULT_LAYERS, LAYERS, type RasterLayer } from './layers.js';
import type { createRelief } from './relief.js';
import { featherCells, paintReach } from './reach.js';
import type { Region } from './region.js';
import { Scratch } from './scratch.js';
import { type BiomeSample, readCell, samplePoint } from './sample.js';

/** One user layer raster write of {@link BiomeWorld.writeLayers}. */
export interface LayerWrite {
  /** `paint/<biome>` or `mask/<name>`. */
  readonly name: string;
  /** Tile indices. */
  readonly x: number;
  readonly z: number;
  /** `cells` x `cells` values 0..255, or undefined to clear the tile's raster. */
  readonly data: Uint8Array | undefined;
  /** World rectangle `[minX, minZ, maxX, maxZ]` (metres) of the cells that changed; default the whole tile. */
  readonly changed?: readonly [number, number, number, number];
}

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
  /** `'cpu'` computes on the CPU; `'gpu'` computes on `device` and needs no workers. `'auto'` computes on `device`
   * when one is given (with no workers) and the world fits it, makes a tile on the CPU when the device fails on it or
   * is lost, and uses the CPU everywhere else; the bytes are the same either way.
   * GPU region axes allow at most 32768 corners and the packed region must fit device buffer limits.
   * Tile rows are banded to fit; at least one row plus margins must fit (a non-perCell zone scorer needs a full tile).
   * Heights and classification sources must be within +/-1073741824
   * (heights in mm). Tile output is byte-identical within this domain; use `'cpu'` for larger domains.
   * Default `'auto'`. */
  readonly backend?: 'auto' | 'gpu' | 'cpu';
  /** The WebGPU device of backends `'gpu'` and `'auto'`. The caller owns it; the world never destroys it. */
  readonly device?: GPUDevice;
  /** Biomes to classify into, at most 254. Default: the temperate preset and its neighbours (alpine, wetland, boreal). */
  readonly biomes?: readonly BiomeDefinition[];
  /** `'envelopes'` (each biome's climate envelope), or `whittaker` or `holdridge` from `@margoengine/biomes/zones`
   * (each biome's `zones`). Default `'envelopes'`. */
  readonly classifier?: 'envelopes' | ZoneClassifier;
  /** Paint layers in composition order (the editor appends one per biome it paints). Default none. */
  readonly paint?: readonly PaintLayer[];
  /**
   * Metres over which a painted edge blends into its neighbour, 0..128. Paint and paint masks are read at the cell the
   * climate warp moves each cell to (so painted borders wander like the climate ones) through a box this wide, in
   * whole cells (`2 * floor(ecotone / (2 * resolution)) + 1`); 0 composes paint cell by cell, a one-cell step. Only
   * worlds with paint change. Default 24.
   */
  readonly ecotone?: number;
  /** Rejects `create` with the signal's reason when aborted. */
  readonly signal?: AbortSignal;
  /**
   * Web Workers that make tiles and stored objects off the page's thread, 0..16 (`false` is 0). Default: hardware
   * threads less one, at most 4, where workers exist (browsers); none elsewhere. The output is byte for byte the same
   * either way. A `field` height source keeps the work on this thread (a function cannot be sent to a worker).
   * GPU worlds start no workers and require 0 or false when this option is supplied.
   */
  readonly workers?: number | false;
  /** Makes one worker, for bundlers that copy worker scripts their own way and for tests. Default: the package's
   * worker script, `dist/workers/biomes.js`. */
  readonly createWorker?: () => Worker;
  /** Tiles kept in the cache; the least recently used go first (a default 256 m tile at 1 m holds about 2.6 MB).
   * 1..4,096. Default 64. */
  readonly cache?: number;
}

/** What the workers entry (`@margoengine/biomes/workers`) reads of a world to make a replica. */
export interface WorldState {
  readonly options: BiomeWorldOptions;
  readonly biomes: readonly BiomeDefinition[];
  readonly classifier: 'envelopes' | ZoneClassifier;
  readonly paint: readonly PaintLayer[];
  readonly user: ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>;
}

/** The worker side of a world (`@margoengine/biomes/workers`), as the world uses it. */
interface Remote {
  tile(x: number, z: number, names: readonly string[]): Promise<BiomeTile>;
  write(writes: readonly LayerWrite[]): void;
  /** False when the change cannot reach a worker (a `field` height): the world works on its own thread from then on. */
  change(changes: object): boolean;
  dispose(): void;
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

type Rect = readonly [number, number, number, number];

/** createRelief from the relief entry, once a world has loaded it. */
let relief: typeof createRelief | undefined, regionEntry: typeof import('@margoengine/biomes/region') | undefined;
/** The GPU entry (checks, bands, loss and kernels), loaded by the first world that may compute on a device. */
let gpu: typeof import('@margoengine/biomes/gpu') | undefined;

const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason;
};

/** Cancellation belongs to the caller, not to a cached tile shared by other callers. */
async function withSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  aborted(signal);
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([pending, cancelled]);
  } catch (error) {
    aborted(signal);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

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
  /** Metres over which a painted edge blends into its neighbour (see {@link BiomeWorldOptions.ecotone}). */
  readonly ecotone: number;
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
  /** Working arrays of tile making, reused from tile to tile (a tile is made start to finish in one go). */
  readonly #scratch = new Scratch();
  /** Working arrays of `heightAt`, apart from the tiles' so a point query never overwrites a tile in the making. */
  readonly #pointScratch = new Scratch();
  /** Finished tiles that hold every default layer, for exact `sample` reads. */
  readonly #ready = new Map<string, BiomeTile>();
  readonly #listeners = new Set<(rect: Rect) => void>();
  /** User layers (`paint/<biome>`, `mask/<name>`): one u8 raster per tile, keyed `x,z`. */
  readonly #user = new Map<string, Map<string, Uint8Array>>();
  #biomes: readonly BiomeDefinition[];
  #kind: 'envelopes' | ZoneClassifier;
  #paint: readonly PaintLayer[];
  #classifier: Classifier;
  #notifying = false;
  #disposed = false;
  readonly #limit: number;
  /** The options as given (climate and heights unquantised), for worker replicas. */
  #given: BiomeWorldOptions;
  #remote?: Remote;
  /** Device tiles of a GPU world (`@margoengine/biomes/gpu`). */
  #gpu?: GpuTiles;

  private constructor(options: BiomeWorldOptions, biomes: readonly BiomeDefinition[]) {
    const seed = options.seed ?? 1,
      size = options.size ?? [4096, 4096],
      tileSize = options.tileSize ?? 256,
      resolution = options.resolution ?? 1,
      regionResolution = options.regionResolution ?? 16,
      backend = options.backend ?? 'auto',
      cache = options.cache ?? 64,
      ecotone = options.ecotone ?? 24;
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
    if (
      options.workers !== undefined &&
      options.workers !== false &&
      !(Number.isInteger(options.workers) && options.workers >= 0 && options.workers <= 16)
    )
      throw rangeError('BiomeWorld workers must be an integer 0..16 or false', 'biomes');
    this.#gpu = gpu?.GpuTiles.of(options, size, regionResolution, tileSize / resolution); // float division: exact
    if (typeof ecotone !== 'number' || !(ecotone >= 0 && ecotone <= 128))
      throw rangeError('BiomeWorld ecotone must be a number of metres, 0..128 (0 keeps painted edges hard)', 'biomes');
    if (!Number.isInteger(cache) || cache < 1 || cache > 4096)
      throw rangeError('BiomeWorld cache must be an integer number of tiles, 1..4,096', 'biomes');
    this.#limit = cache;
    this.#given = options;
    this.seed = seed >>> 0;
    this.tileSize = tileSize;
    this.ecotone = ecotone;
    this.resolution = resolution;
    this.regionResolution = regionResolution;
    this.#origin = [Math.round(origin[0] * 1000), Math.round(origin[1] * 1000)];
    this.#size = [size[0] * 1000, size[1] * 1000];
    this.bounds = Object.freeze([origin[0], origin[1], origin[0] + size[0], origin[1] + size[1]] as const);
    this.tilesX = -divFloor(-size[0], tileSize);
    this.tilesZ = -divFloor(-size[1], tileSize);
    this.#climate = quantizeClimate(options.climate);
    this.#biomes = biomes;
    this.#kind = options.classifier ?? 'envelopes';
    this.#paint = options.paint ?? [];
    [this.#biomes, this.#classifier] = this.#buildClassifier();
    this.#fit(this.#classifier, this.#kind);
    this.#heights = regionEntry!.heightsOf(options.height, this.#origin, this.#size, this.seed, relief);
    this.#region = this.#buildRegion();
  }

  /**
   * Makes a world: validates the options, samples the region heights and builds the region fields (on this thread).
   * @throws TypeError for a missing GPU `device`; RangeError for bad options or GPU workers (pass `workers: 0`).
   */
  static async create(options: BiomeWorldOptions = {}): Promise<BiomeWorld> {
    if (typeof options !== 'object' || options === null)
      throw typeError('BiomeWorld options must be an object; pass {} for the defaults', 'biomes');
    aborted(options.signal);
    const biomes = options.biomes ?? (await defaultBiomes()),
      h = options.height;
    // The procedural relief is its own entry, loaded only for worlds that use it (the default height).
    if (h === undefined || (typeof h === 'object' && h !== null && 'relief' in h))
      relief ??= (await import('@margoengine/biomes/relief')).createRelief;
    // Heights and region fields are their own entry, so a program that only defines biomes never loads them.
    regionEntry ??= await import('@margoengine/biomes/region');
    // The GPU checks, bands and kernels are their own entry, loaded only for a world that may compute on a device.
    if (options.backend === 'gpu' || (options.device && options.backend !== 'cpu'))
      gpu ??= await import('@margoengine/biomes/gpu');
    aborted(options.signal);
    const world = new BiomeWorld(options, biomes),
      { workers } = options;
    // Workers are their own entry, loaded only for a world that uses them (by default where Web Workers exist).
    const auto = workers === undefined && typeof Worker === 'function' && typeof globalThis.location !== 'undefined';
    if (!world.#gpu && (auto || (workers && workers > 0)) && !(h && typeof h === 'object' && 'field' in h)) {
      const { BiomeWorkers, defaultWorkers } = await import('@margoengine/biomes/workers'),
        count = workers || defaultWorkers();
      if (count) world.#remote = new BiomeWorkers(count, world, () => world.#state(), options.createWorker);
    }
    aborted(options.signal);
    world.#gpu?.watch();
    return world;
  }

  /** The state a worker replica is made from (the workers entry builds its message). */
  #state(): WorldState {
    return {
      options: this.#given,
      biomes: this.#biomes,
      classifier: this.#kind,
      paint: this.#paint,
      user: this.#user,
    };
  }

  /**
   * The world's workers (`BiomeWorkers` of `@margoengine/biomes/workers`), or undefined on a world without them:
   * placement and views send their jobs there.
   */
  get workers(): import('@margoengine/biomes/workers').BiomeWorkers | undefined {
    return this.#remote as import('@margoengine/biomes/workers').BiomeWorkers | undefined;
  }

  #buildClassifier(
    biomes = this.#biomes,
    kind = this.#kind,
    paint = this.#paint,
  ): readonly [readonly BiomeDefinition[], Classifier] {
    if (!Array.isArray(biomes) || biomes.length < 1 || biomes.length > 254)
      throw rangeError('BiomeWorld biomes must be 1 to 254 biome definitions', 'biomes');
    const checked = biomes.map((b) => defineBiome(b)),
      ids = checked.map((b) => b.id);
    if (new Set(ids).size !== ids.length) throw rangeError('BiomeWorld biome ids must be unique', 'biomes');
    if (kind !== 'envelopes' && typeof (kind as ZoneClassifier)?.scorer !== 'function')
      throw rangeError(
        "BiomeWorld classifier is 'envelopes' or whittaker or holdridge from '@margoengine/biomes/zones'",
        'biomes',
      );
    if (!checkPaint(paint, ids))
      throw rangeError('A paint layer names a biome of this world, an optional mode and an optional mask', 'biomes');
    return [checked, classifier(checked, kind, paint)];
  }

  /** The biome definitions in force (the indices in the `biome` layer point into this list). */
  get biomes(): readonly BiomeDefinition[] {
    return this.#biomes;
  }

  /**
   * River centre lines of a world with a procedural relief, in millimetres, mouth first (`Relief.rivers`). Empty for a
   * world from `samples` or `source` heights.
   */
  get rivers(): readonly Int32Array[] {
    return this.#heights.relief?.rivers ?? [];
  }

  /** The region fields: grids of corner samples over the whole world (`@margoengine/biomes/hydrology` reads its heights). */
  get region(): Region {
    return this.#region;
  }

  /** The paint layers in composition order. */
  get paint(): readonly PaintLayer[] {
    return this.#paint;
  }

  #buildRegion(heights = this.#heights, climate = this.#climate): Region {
    const step = this.regionResolution * 1000,
      nx = divFloor(this.#size[0], step) + 1,
      nz = divFloor(this.#size[1], step) + 1,
      height = heights.grid(0, 0, nx, nz, step),
      water = heights.relief?.waterCells(this.#origin, step, nx, nz);
    this.#fit(undefined, undefined, height);
    return regionEntry!.buildRegion(height, nx, nz, step, climate, water);
  }

  #live(): void {
    if (this.#disposed)
      throw fault('disposed', 'BiomeWorld is disposed; create a new one with BiomeWorld.create()', 'biomes');
  }

  /** Backend `'gpu'` throws for a state its device cannot hold; `'auto'` drops the device and goes on with the CPU. */
  #fit(c?: Classifier, kind?: 'envelopes' | ZoneClassifier, height?: ArrayLike<number>): void {
    if (this.#gpu?.fits(c, kind, height) === false) {
      this.#gpu.dispose();
      this.#gpu = undefined;
    }
  }

  #gpuLive(): void {
    this.#live();
    this.#gpu?.live();
  }

  /**
   * The region heights as a quick overview of the whole world: corner samples every `regionResolution` metres, in
   * metres, rows of increasing z (`width` x `depth`). Views draw it while the 1 m tiles are made.
   */
  overview(): {
    readonly width: number;
    readonly depth: number;
    readonly resolution: number;
    readonly height: Float32Array;
  } {
    this.#live();
    const r = this.#region,
      height = new Float32Array(r.height.length);
    for (let i = 0; i < height.length; i++) height[i] = r.height[i] / 1000;
    return { width: r.nx, depth: r.nz, resolution: this.regionResolution, height };
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
    this.#gpuLive();
    const key = `${x},${z}:${[...names].sort().join(',')}`;
    let pending = this.#cache.get(key);
    if (pending) {
      // Least recently used goes first: a hit moves to the end.
      this.#cache.delete(key);
      this.#cache.set(key, pending);
    } else {
      pending = this.#remote ? this.#remote.tile(x, z, names) : this.#make(x, z, names);
      this.#cache.set(key, pending);
      if (this.#cache.size > this.#limit) {
        const oldest = this.#cache.keys().next().value!;
        this.#cache.delete(oldest);
        this.#ready.delete(oldest.slice(0, oldest.indexOf(':')));
      }
      pending.then(
        (tile) => {
          if (this.#cache.get(key) === pending && DEFAULT_LAYERS.every((name) => tile.layers.includes(name)))
            this.#ready.set(`${x},${z}`, tile);
        },
        () => {
          if (this.#cache.get(key) === pending) this.#cache.delete(key);
        },
      );
    }
    const tile = await withSignal(pending, options.signal);
    aborted(options.signal);
    this.#gpuLive();
    return tile;
  }

  /**
   * Part of one tile: the cells of `window` (`[i0, j0, i1, j1]` in tile cells, `i1` and `j1` exclusive), every layer
   * `(i1 - i0)` x `(j1 - j0)` cells, row-major, with the same bytes as those cells of {@link BiomeWorld.tile}.
   * Placement makes the edge of each neighbour it reads this way instead of the whole tile. Answers with the whole
   * tile (window `[0, 0, cells, cells]`) when the world holds one with the layers, and, made by {@link BiomeWorld.tile},
   * when a classified layer is asked of a world whose zone classifier is not `perCell`. A part is never cached, and it
   * is made on this thread, also on a world with workers.
   * @throws RangeError for a tile outside the world, a window that is empty or leaves the tile, or an unknown layer
   * name; MargoError `'disposed'` after dispose. Rejects with the signal's reason when aborted.
   * @example
   * // The 64 m strip of tile (1, 0) next to tile (0, 0), on a world of 256 m tiles at 1 m.
   * const part = await world.tilePart(1, 0, [0, 0, 64, 256]);
   * const height = part.layer('height')!; // part.window[2] - part.window[0] cells wide
   */
  async tilePart(
    x: number,
    z: number,
    window: Rect,
    options: TileRequest = {},
  ): Promise<BiomeTile & { readonly window: Rect }> {
    this.#live();
    if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || z < 0 || x >= this.tilesX || z >= this.tilesZ)
      throw rangeError(
        'BiomeWorld tile indices must be integers inside the world (0..tilesX - 1, 0..tilesZ - 1)',
        'biomes',
      );
    const cells = (this.tileSize * 2) / (this.resolution * 2); // float division: 128..1024, exact
    if (
      !Array.isArray(window) ||
      window.length !== 4 ||
      !window.every(Number.isInteger) ||
      window[0] < 0 ||
      window[1] < 0 ||
      window[2] > cells ||
      window[3] > cells ||
      window[0] >= window[2] ||
      window[1] >= window[3]
    )
      throw rangeError(
        'BiomeWorld tilePart window is [i0, j0, i1, j1] in tile cells with 0 <= i0 < i1 <= cells and 0 <= j0 < j1 <= cells',
        'biomes',
      );
    const names = options.layers ?? DEFAULT_LAYERS;
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string' && name in LAYERS))
      throw rangeError('Unknown biome layer name; use names from LAYERS', 'biomes');
    aborted(options.signal);
    this.#gpuLive();
    // A zone scorer that is not marked per cell may read the grid it classifies: only the whole tile has its bytes.
    const k = this.#kind,
      whole =
        k !== 'envelopes' && !k.perCell && (names.includes('biome') || names.includes('biomeWeight'))
          ? await this.tile(x, z, options)
          : this.#ready.get(`${x},${z}`);
    if (whole && names.every((name) => whole.layers.includes(name)))
      return Object.freeze({ ...whole, window: Object.freeze([0, 0, cells, cells] as const) });
    if (!this.#gpu) await Promise.resolve();
    this.#live();
    aborted(options.signal);
    const [i0, j0, i1, j1] = window,
      layers = await this.#layers(x * cells + i0, z * cells + j0, i1 - i0, j1 - j0, names, options.signal);
    return Object.freeze({
      x,
      z,
      origin: Object.freeze([this.bounds[0] + x * this.tileSize, this.bounds[1] + z * this.tileSize] as const),
      cells,
      resolution: this.resolution,
      layers: Object.freeze(Object.keys(LAYERS).filter((name) => layers.has(name))),
      layer: (name: string) => layers.get(name),
      window: Object.freeze([i0, j0, i1, j1] as const),
    });
  }

  async #make(x: number, z: number, names: readonly string[]): Promise<BiomeTile> {
    if (!this.#gpu) await Promise.resolve();
    this.#live();
    const cells = (this.tileSize * 2) / (this.resolution * 2), // float division: 128..1024, exact
      layers = await this.#layers(x * cells, z * cells, cells, cells, names);
    const list = Object.keys(LAYERS).filter((name) => layers.has(name));
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
   * The named layers of `width` x `depth` cells from global cell (gx, gz): the bytes those cells hold in their tiles,
   * as every layer is a function of the global cell and classification reads the same global margins around it.
   */
  async #layers(
    gx: number,
    gz: number,
    width: number,
    depth: number,
    names: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, RasterLayer>> {
    const g = this.#gpu,
      frame = {
        climate: this.#climate,
        region: this.#region,
        heights: this.#heights,
        cell: this.resolution * 1000,
        scratch: this.#scratch,
      };
    if (!g) {
      this.#live();
      aborted(signal);
      return this.#cpuLayers(frame, gx, gz, width, depth, names);
    }
    // Updates replace frames and rasters; keep this revision for every awaited band and CPU tail.
    const user = new Map([...this.#user].map(([name, tiles]) => [name, new Map(tiles)])),
      ecotone = featherCells(this.ecotone, this.resolution),
      c = this.#classifier;
    return g.layers(
      {
        frame: Object.freeze(frame),
        classifier: c,
        kind: this.#kind,
        gx,
        gz,
        width,
        depth,
        names,
        input: (wide, z, rows) => this.#input(wide, gx, z, width, rows, user, ecotone),
      },
      signal,
      () => this.#live(),
      // Backend 'auto' makes a tile the device failed on here, from the same revision.
      () => this.#cpuLayers(frame, gx, gz, width, depth, names, c, user),
    );
  }

  /** The layers of a cell rectangle, made on this thread (from classifier `c` and user rasters `user`). */
  #cpuLayers(
    frame: TileFrame,
    gx: number,
    gz: number,
    width: number,
    depth: number,
    names: readonly string[],
    c = this.#classifier,
    user?: ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>,
  ): Map<string, RasterLayer> {
    if (!classified(names)) return rectFields(frame, gx, gz, width, depth, names);
    // Classification blurs over a 1-cell margin: compute the fields one cell wider, classify, then crop.
    // The wide fields are working arrays: the result keeps cropped copies.
    const wide = rectFields(frame, gx - 1, gz - 1, width + 2, depth + 2, wideNames(names, c), true),
      ids = new Uint8Array(width * depth * 4),
      weights = new Uint8Array(width * depth * 4);
    classify(c, this.#input(wide, gx, gz, width, depth, user), ids, weights);
    return assemble(names, wide, ids, weights, width, depth);
  }

  /** The classification grid over the wide (1-cell margin) fields of a rectangle, with a request's user rasters. */
  #input(
    wide: ReadonlyMap<string, RasterLayer>,
    gx: number,
    gz: number,
    width: number,
    depth: number,
    user: ReadonlyMap<string, ReadonlyMap<string, Uint8Array>> = this.#user,
    ecotone = featherCells(this.ecotone, this.resolution),
  ): ClassifyInput {
    const cells = (this.tileSize * 2) / (this.resolution * 2), // float division: 128..1024, exact
      n = width + 2,
      rows = depth + 2,
      ox = gx - 1,
      oz = gz - 1;
    return {
      n,
      depth: rows,
      gx: ox,
      gz: oz,
      seed: this.seed,
      cell: this.resolution * 1000,
      layer: (name) => wide.get(name)!.data,
      // The feather's wide read stays inside the world (edge cells repeat), so paint keeps full strength up to
      // the world's edge instead of fading into cells that do not exist.
      user: (name, margin = 0) =>
        userGrid(
          user,
          this.tilesX,
          this.tilesZ,
          name,
          ox - margin,
          oz - margin,
          n + 2 * margin,
          cells,
          !!margin,
          rows + 2 * margin,
        ),
      ecotone,
    };
  }

  /**
   * A copy of a user layer's raster for tile (x, z) (`paint/<biome>` or `mask/<name>`, u8, `cells` x `cells`), or
   * undefined where nothing was written.
   */
  readLayer(name: string, x: number, z: number): Uint8Array | undefined {
    this.#live();
    const data = this.#user.get(name)?.get(`${x},${z}`);
    return data ? data.slice() : undefined;
  }

  /**
   * Writes a user layer raster for tile (x, z): `paint/<biome>` (0..255, composed into the biome weights by the world's
   * paint layers; a biome painted for the first time gets a `'replace'` layer at the end of the order) or
   * `mask/<name>` (0..255, read by envelopes and paint masks). `data` is `cells` x `cells`, or undefined to clear.
   * Same as `writeLayers([{ name, x, z, data }])`.
   * @throws RangeError for a bad name, tile or size; MargoError `'state'` from inside an `onChange` listener.
   */
  writeLayer(name: string, x: number, z: number, data: Uint8Array | undefined): void {
    this.writeLayers([{ name, x, z, data }]);
  }

  /**
   * Writes several user layer rasters at once: all are checked first (nothing is written when one is bad), the tiles
   * they can change are recomputed on their next request, and listeners get one rectangle: the union of the changed
   * cells grown by the cells classification reads across (one for the blur, or the paint feather's box and warp, twice
   * its half width, when the `ecotone` is wider), clamped to the world.
   * @throws RangeError for a bad name, tile or size; MargoError `'state'` from inside an `onChange` listener.
   */
  writeLayers(writes: readonly LayerWrite[]): void {
    this.#live();
    if (this.#notifying)
      throw fault(
        'state',
        'BiomeWorld writeLayer called from an onChange listener; write after the listener returns',
        'biomes',
      );
    if (!Array.isArray(writes)) throw typeError('BiomeWorld writeLayers takes an array of layer writes', 'biomes');
    const cells = (this.tileSize * 2) / (this.resolution * 2), // float division: exact
      t = this.tileSize,
      r = this.resolution * paintReach(this.ecotone, this.resolution),
      [bx0, bz0, bx1, bz1] = this.bounds;
    for (const w of writes) {
      const paint = /^paint\/([a-z0-9][a-z0-9-]*)$/.exec(w?.name);
      if (!(paint ? this.#classifier.ids.includes(paint[1]) : /^mask\/[\w-]+$/.test(w?.name)))
        throw rangeError('A user layer is paint/<biome id of this world> or mask/<name>', 'biomes');
      if (
        !Number.isInteger(w.x) ||
        !Number.isInteger(w.z) ||
        w.x < 0 ||
        w.z < 0 ||
        w.x >= this.tilesX ||
        w.z >= this.tilesZ
      )
        throw rangeError(
          'BiomeWorld tile indices must be integers inside the world (0..tilesX - 1, 0..tilesZ - 1)',
          'biomes',
        );
      if (w.data !== undefined && (!(w.data instanceof Uint8Array) || w.data.length !== cells * cells))
        throw rangeError('A user layer raster is a Uint8Array of cells x cells values', 'biomes');
      if (
        w.changed !== undefined &&
        (!Array.isArray(w.changed) || w.changed.length !== 4 || !w.changed.every(Number.isFinite))
      )
        throw rangeError('A layer write changed rectangle is [minX, minZ, maxX, maxZ] in metres', 'biomes');
    }
    if (!writes.length) return;
    const dirty = [Infinity, Infinity, -Infinity, -Infinity];
    for (const w of writes) {
      let tiles = this.#user.get(w.name);
      if (!tiles) this.#user.set(w.name, (tiles = new Map()));
      if (w.data) tiles.set(`${w.x},${w.z}`, w.data.slice());
      else tiles.delete(`${w.x},${w.z}`);
      const biome = /^paint\/(.+)$/.exec(w.name)?.[1];
      if (biome && !this.#paint.some((p) => p.biome === biome)) {
        this.#paint = [...this.#paint, { biome, mode: 'replace' }];
        this.#classifier = classifier(this.#biomes, this.#kind, this.#paint);
      }
      const c = w.changed ?? [bx0 + w.x * t, bz0 + w.z * t, bx0 + (w.x + 1) * t, bz0 + (w.z + 1) * t];
      dirty[0] = Math.min(dirty[0], c[0] - r);
      dirty[1] = Math.min(dirty[1], c[1] - r);
      dirty[2] = Math.max(dirty[2], c[2] + r);
      dirty[3] = Math.max(dirty[3], c[3] + r);
    }
    this.#remote?.write(writes);
    const rect = [
      Math.max(bx0, dirty[0]),
      Math.max(bz0, dirty[1]),
      Math.min(bx1, dirty[2]),
      Math.min(bz1, dirty[3]),
    ] as const;
    // Tiles whose cells (plus the classification margin) meet the rectangle.
    this.#invalidate(this.#tileRange([rect[0] - r, rect[1] - r, rect[2] + r, rect[3] + r]));
    this.#emit(rect);
  }

  /** Drops cached tiles in an inclusive tile-index rectangle. */
  #invalidate([x0, z0, x1, z1]: readonly [number, number, number, number]): void {
    for (const key of [...this.#cache.keys()]) {
      const [x, z] = key.slice(0, key.indexOf(':')).split(',').map(Number);
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) {
        this.#cache.delete(key);
        this.#ready.delete(`${x},${z}`);
      }
    }
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
    if (tile) return readCell(tile, gx - tile.x * cells, gz - tile.z * cells, this.#classifier.ids, out);
    return this.sampleRegion(x, z, out);
  }

  /**
   * Point query from the region fields only, synchronous: what {@link BiomeWorld.sample} answers where no tile is
   * cached, the same whatever tiles were made before (views build their far-field overview from it).
   */
  sampleRegion(x: number, z: number, out?: BiomeSample): BiomeSample {
    this.#live();
    if (!Number.isFinite(x) || !Number.isFinite(z))
      throw rangeError('BiomeWorld sampleRegion needs finite x and z', 'biomes');
    const gx = Math.floor((x - this.bounds[0]) / this.resolution), // float division: metres to cells
      gz = Math.floor((z - this.bounds[1]) / this.resolution), // float division
      cells = this.tileSize / this.resolution; // float division: exact
    return samplePoint(
      this.#climate,
      this.#region,
      this.#classifier,
      {
        seed: this.seed,
        cell: this.resolution * 1000,
        user: (name) => userGrid(this.#user, this.tilesX, this.tilesZ, name, gx, gz, 1, cells)?.[0],
      },
      this.#origin,
      x,
      z,
      out,
    );
  }

  /**
   * The ground height in metres at world (x, z), synchronous and without tiles: the bilinear blend of the four height
   * cells around the point, which are the values the tiles' `height` layer holds (so a character placed with this
   * stands on the surface a `BiomeView` draws, to within the view's texel spacing, `textureResolution`). Points outside the world answer
   * for the nearest edge. Allocation free once warm; the same bytes on every machine.
   * @throws RangeError when x or z is not finite.
   */
  heightAt(x: number, z: number): number {
    this.#live();
    if (!Number.isFinite(x) || !Number.isFinite(z))
      throw rangeError('BiomeWorld heightAt needs finite x and z', 'biomes');
    const cell = this.resolution * 1000,
      u = (Math.min(this.bounds[2], Math.max(this.bounds[0], x)) - this.bounds[0]) / this.resolution, // float division: metres to cells
      v = (Math.min(this.bounds[3], Math.max(this.bounds[1], z)) - this.bounds[1]) / this.resolution, // float division
      gx = Math.floor(u),
      gz = Math.floor(v),
      h = this.#heights.grid(gx, gz, 2, 2, cell, this.#pointScratch),
      top = h[0] + (h[1] - h[0]) * (u - gx),
      bottom = h[2] + (h[3] - h[2]) * (u - gx);
    return (top + (bottom - top) * (v - gz)) / 1000; // float division: millimetres to metres
  }

  /**
   * Replaces the biomes, classifier, paint order, climate or heights; every tile is recomputed on its next request and
   * listeners get the world rectangle. Height edits change fields far downwind (rain shadow) and downstream, so the whole world is dirty.
   * @throws MargoError `'state'` when called from inside an `onChange` listener.
   */
  update(changes: Partial<Pick<BiomeWorldOptions, 'biomes' | 'climate' | 'classifier' | 'paint' | 'height'>>): void {
    this.#live();
    if (this.#notifying)
      throw fault(
        'state',
        'BiomeWorld update called from an onChange listener; update after the listener returns',
        'biomes',
      );
    if (typeof changes !== 'object' || changes === null)
      throw typeError('BiomeWorld update takes { biomes?, classifier?, paint?, climate?, height? }', 'biomes');
    const kind = changes.classifier ?? this.#kind,
      paint = changes.paint ?? this.#paint,
      [biomes, classifier] = this.#buildClassifier(changes.biomes ?? this.#biomes, kind, paint),
      climate = changes.climate ? quantizeClimate(changes.climate) : this.#climate;
    this.#fit(classifier, kind);
    const heights = changes.height
        ? regionEntry!.heightsOf(changes.height, this.#origin, this.#size, this.seed, relief)
        : this.#heights,
      region = changes.climate || changes.height ? this.#buildRegion(heights, climate) : this.#region;
    this.#biomes = biomes;
    this.#classifier = classifier;
    this.#kind = kind;
    this.#paint = paint;
    this.#climate = climate;
    this.#heights = heights;
    this.#region = region;
    this.#given = { ...this.#given, ...changes };
    if (this.#remote && !this.#remote.change(changes)) {
      this.#remote.dispose();
      this.#remote = undefined;
    }
    this.#cache.clear();
    this.#ready.clear();
    this.#emit(this.bounds);
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
    return (await import('@margoengine/biomes/digest')).tileDigest(tile);
  }

  /** Frees the cache and listeners; later calls throw MargoError `'disposed'`. */
  dispose(): void {
    this.#disposed = true;
    this.#gpu?.dispose(
      fault('disposed', 'BiomeWorld is disposed; create a new one with BiomeWorld.create()', 'biomes'),
    );
    this.#remote?.dispose();
    this.#remote = undefined;
    this.#cache.clear();
    this.#ready.clear();
    this.#listeners.clear();
    this.#user.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** The default biomes: the temperate preset and its neighbours, loaded from the presets entry on first use. */
async function defaultBiomes(): Promise<readonly BiomeDefinition[]> {
  const { presets } = await import('@margoengine/biomes/presets');
  return [presets.temperate, presets.alpine, presets.wetland, presets.boreal];
}

/** A user layer over an n x rows grid of global cells from (gx, gz): 0..255, -1 where unpainted; undefined when the
 * layer holds nothing. `clamp` reads a cell outside the world at the nearest cell inside it. */
function userGrid(
  user: ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>,
  tilesX: number,
  tilesZ: number,
  name: string,
  gx: number,
  gz: number,
  n: number,
  cells: number,
  clamp = false,
  rows = n,
): Int16Array | undefined {
  const tiles = user.get(name);
  if (!tiles?.size) return undefined;
  const out = new Int16Array(n * rows).fill(-1);
  if (clamp) {
    // In-world runs per row as below, then the columns and rows past the world's edge copy its edge cells.
    const lastX = tilesX * cells - 1,
      lastZ = tilesZ * cells - 1,
      i0 = Math.max(0, -gx),
      i1 = Math.min(n, lastX + 1 - gx),
      j0 = Math.max(0, -gz),
      j1 = Math.min(rows, lastZ + 1 - gz);
    for (let j = j0; j < j1; j++) {
      const tz = divFloor(gz + j, cells),
        row = (gz + j - tz * cells) * cells,
        at = j * n;
      for (let i = i0; i < i1; ) {
        const tx = divFloor(gx + i, cells),
          x = gx + i - tx * cells,
          run = Math.min(i1 - i, cells - x),
          data = tiles.get(`${tx},${tz}`);
        if (data) out.set(data.subarray(row + x, row + x + run), at + i);
        i += run;
      }
      out.fill(out[at + i0], at, at + i0);
      out.fill(out[at + i1 - 1], at + i1, at + n);
    }
    for (let j = 0; j < j0; j++) out.copyWithin(j * n, j0 * n, j0 * n + n);
    for (let j = j1; j < rows; j++) out.copyWithin(j * n, (j1 - 1) * n, j1 * n);
    return out;
  }
  for (let j = 0; j < rows; j++) {
    const tz = divFloor(gz + j, cells),
      row = (gz + j - tz * cells) * cells;
    for (let i = 0; i < n; ) {
      const tx = divFloor(gx + i, cells),
        x = gx + i - tx * cells,
        run = Math.min(n - i, cells - x),
        data = tiles.get(`${tx},${tz}`);
      if (data) out.set(data.subarray(row + x, row + x + run), j * n + i);
      i += run;
    }
  }
  return out;
}
