/// <reference lib="esnext.disposable" preserve="true" />
// Height streaming for worlds bigger than one heightmap. The terrain draws one heightmap, a window of `window` x
// `window` tiles centred on the camera; as the camera crosses into a new tile the window moves by whole tiles. Only the
// newly exposed tiles are loaded and uploaded, the incremental update of a clipmap level as the viewer moves (Tanner,
// Migdal and Jones 1998, "The Clipmap: A Virtual Mipmap", SIGGRAPH; Losasso and Hoppe 2004, "Geometry Clipmaps:
// Terrain Rendering Using Nested Regular Grids", SIGGRAPH, section 3; Asirvatham and Hoppe 2005, GPU Gems 2 ch. 2).
// Both wrap the texture toroidally so kept texels never move; that would change the root terrain shader, which clamps.
// Here the kept texels are scrolled instead, by two GPU texture copies through a scratch texture (no CPU upload), so
// the root shader and everyone who does not stream keep their code. A tile's texels sit at the same world positions in
// every window, so the drawn ground does not move when the window does. Uploads go in bands of rows within a texel
// budget per frame, the nearest tile first, so a tile never stalls a frame. `far` (`@margoengine/terrain/far`) adds a
// second, coarser window of the same kind (stream-window.ts) for the ground past this one.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { Terrain, type TerrainOptions, type TerrainSource, type TerrainTextures } from './index.js';
import {
  TileWindow,
  type TerrainStreamChange,
  type TerrainStreamLoad,
  type TerrainStreamTile,
  type TerrainTiles,
} from './stream-window.js';
export type {
  TerrainStreamChange,
  TerrainStreamLoad,
  TerrainStreamTile,
  TerrainTiles,
} from './stream-window.js';

/** {@link TerrainStream} options: the terrain's own options without `textures`, `origin` and `size`, plus these.
 * The clipmap window defaults to `'camera'`, on the same world lattice as its tiles. */
export interface TerrainStreamOptions extends Omit<TerrainOptions, 'textures' | 'origin' | 'size'> {
  /** World size of a tile side, above 0. */
  readonly tileSize: number;
  /** Height samples per tile side, an integer from 2 to 1,024. Adjacent tiles share no samples. */
  readonly tileTexels: number;
  /** Tiles per window side, an even integer from 2 to 16. Default 4. The window must fit the device's 2D texture limit. */
  readonly window?: number;
  /** World XZ of tile (0, 0)'s minimum corner (its first sample). Default [0, 0]. */
  readonly origin?: readonly [number, number];
  /**
   * Loads tile (x, z) (any integers; tile (x, z) starts at `origin + [x, z] * tileSize`). Resolve undefined or null
   * for no data there (the tile keeps `fill`; with `far` the far ring's ground shows there). `signal` aborts when the
   * tile leaves the window or the stream is disposed.
   */
  readonly load: (x: number, z: number, signal: AbortSignal) => Promise<TerrainStreamTile | null | undefined>;
  /** Makes the layer colour array (`TerrainTextures.layers`), at attachment and again after device restoration. */
  readonly colors: (device: GPUDevice) => GPUTexture;
  /** Painted weight textures per tile, 0 to 4 (enough for the layers, 4 each). Default 0: the height and slope rules. */
  readonly weights?: number;
  /** Texels uploaded per frame (one tile row at least). Default 65,536 (one 256 x 256 tile). */
  readonly budget?: number;
  /** Tile loads in flight at once, 1 to 64, the far ring's included. Default 4. */
  readonly concurrency?: number;
  /** Height of texels whose tile is not loaded yet, finite. Default 0. */
  readonly fill?: number;
  /** Aborts every load; no new ones start, and `ready` rejects with its reason. */
  readonly signal?: AbortSignal;
  /**
   * Times a tile whose `load` rejects is loaded again before it counts as failed, 0 to 16. Default 2. A tile of the
   * wrong shape and an aborted load are not retried. `retry()` starts every failed tile over.
   */
  readonly retries?: number;
  /**
   * Base wait before a retry in milliseconds, 0 or more. Default 250. Retry k (from 0) waits a random time up to
   * `retryDelay * 2^k`, capped at 30 s (exponential backoff with full jitter), so tiles that failed together do not
   * all ask again at once.
   */
  readonly retryDelay?: number;
  /**
   * Stream a normal map with the heights: each tile with data gives `normals`, and the terrain shades with them in place
   * of normals from neighbouring heights (`TerrainTextures.normalmap`), so lighting keeps detail finer than the height
   * samples. Texels not loaded yet face straight up. Default false.
   */
  readonly normals?: boolean;
  /**
   * Stream a tint texture with the heights (`TerrainTextures.tint`, as `rgba8unorm-srgb`; needs `weights`): layers with
   * `tint: true` move toward each tile's `tint` colour by its A, a draped photograph or a season map. Texels not loaded
   * yet, and tiles without `tint`, are untinted. Default false.
   */
  readonly tint?: boolean;
  /**
   * Draw coarser ground past the window: `terrainFar({ scale, load })` from `@margoengine/terrain/far`, a second window
   * of bigger tiles the heights blend into with distance. With it, `levels` defaults to enough rings to reach the far
   * ring's edge. Default: none (nothing past the window is drawn).
   */
  readonly far?: TerrainStreamFar;
}

/** A tile window the far ring reads: its tiles, which hold data, and its textures. */
export interface TerrainStreamWindow extends TerrainTiles {
  /** Whether tile (x, z) is resident with loaded data, not just `fill`. */
  holds(x: number, z: number): boolean;
  /** The window's textures, made for the current device. */
  readonly textures: {
    readonly height: GPUTexture;
    readonly weights: readonly GPUTexture[];
    readonly normals?: GPUTexture;
    readonly tint?: GPUTexture;
  };
}

/** What a {@link TerrainStream} needs of its far ring; `terrainFar` (`@margoengine/terrain/far`) makes one. */
export interface TerrainStreamFar {
  /** Loads far tile (x, z), which starts at the stream's `origin + [x, z] * tileSize` of the far ring. */
  readonly load: TerrainStreamLoad;
  /**
   * The far window for a stream with these tiles: its tile side in world units, texels and tiles per side, and how far
   * from the camera on each axis it draws (`reach`).
   * @throws RangeError when the two windows do not fit together.
   */
  plan(near: { tileSize: number; tileTexels: number; window: number }): {
    tileSize: number;
    tileTexels: number;
    window: number;
    reach: number;
  };
  /** Joins the two windows: returns what draws and updates the blend between them. */
  bind(
    near: TerrainStreamWindow,
    far: TerrainStreamWindow,
    terrain: Pick<TerrainOptions, 'heightScale' | 'heightOffset'>,
  ): {
    /** The shader additions on `device`, at attachment and after device restoration (after both windows' textures). */
    source(device: GPUDevice): TerrainSource;
    /** One frame: the camera's world XZ and the seconds since the last. Returns whether the drawn ground changed. */
    update(delta: number, x: number, z: number): boolean;
    dispose(): void;
  };
}

interface Waiter {
  resolve(): void;
  reject(reason: unknown): void;
}

/** The shift of a terrain without a floating origin. */
const NO_SHIFT: readonly number[] = [0, 0, 0];
let nextId = 0;
const integer = (v: unknown, lo: number, hi: number): boolean =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/**
 * A {@link Terrain} whose heightmap (and painted weights) stream in tiles around the camera, so the world can be far
 * bigger than one heightmap. Attach with {@link TerrainStream.attach}; it makes and owns the terrain (`terrain`).
 * The window follows the engine camera: it moves a whole tile when the camera is more than 0.75 of a tile from its
 * centre, so ground at least `(window / 2 - 0.75) * tileSize` from the camera on each axis is always in it (the
 * terrain draws nothing past the window, as past any heightmap, unless `far` adds a coarser ring there).
 */
export class TerrainStream implements EnginePlugin {
  readonly name = 'terrain-stream:' + nextId++;
  /** The terrain drawing the window. The stream owns it: `dispose()` disposes it. */
  readonly terrain: Terrain;
  /** Texels per window side (`window * tileTexels`). */
  readonly columns: number;
  /** CPU copy of the heightmap, `columns` x `columns`, row by row from `origin` (kept in place: the same array always). */
  readonly heights: Float32Array;
  /** CPU copies of the weight textures, RGBA bytes, as `heights`. */
  readonly weights: readonly Uint8Array[];
  /** CPU copy of the normal map with `normals`, RGBA bytes as `heights`; else undefined. */
  readonly normals?: Uint8Array;
  /** CPU copy of the tint with `tint`, RGBA bytes as `heights`; else undefined. */
  readonly tint?: Uint8Array;
  /** With `far`: the far ring's own window of tiles. */
  readonly far?: TerrainTiles;
  disposed = false;
  readonly #o: TerrainStreamOptions;
  readonly #near: TileWindow;
  readonly #far?: TileWindow;
  readonly #ring?: ReturnType<TerrainStreamFar['bind']>;
  readonly #waiters = new Set<Waiter>();
  #engine?: Engine;
  #attached = false;

  private constructor(engine: EngineKernel, options: TerrainStreamOptions) {
    const o = options;
    if (!o || typeof o.load !== 'function' || typeof o.colors !== 'function')
      throw new TypeError('Invalid terrain stream; pass load(x, z, signal) and colors(device) functions.');
    const origin = o.origin ?? [0, 0];
    if (
      !(o.tileSize > 0 && Number.isFinite(Math.fround(o.tileSize))) ||
      !integer(o.tileTexels, 2, 1024) ||
      !integer(o.window ?? 4, 2, 16) ||
      (o.window ?? 4) % 2 ||
      !integer(o.weights ?? 0, 0, 4) ||
      (o.weights && o.weights * 4 < (o.layers?.length ?? 0)) ||
      !integer(o.budget ?? 65536, 1, 2 ** 26) ||
      !integer(o.concurrency ?? 4, 1, 64) ||
      !Number.isFinite(Math.fround(o.fill ?? 0)) ||
      !integer(o.retries ?? 2, 0, 16) ||
      !((o.retryDelay ?? 250) >= 0 && Number.isFinite(o.retryDelay ?? 250)) ||
      !Array.isArray(origin) ||
      !origin.every((v) => Number.isFinite(v))
    )
      throw new RangeError(
        'Invalid terrain stream options; give tileSize above 0, tileTexels 2..1024, an even window 2..16, weights 0..4 (4 layers each), budget and concurrency (1..64) whole numbers, retries 0..16, a retryDelay of 0 ms or more, and a finite fill and origin.',
      );
    if (o.far !== undefined && (typeof o.far?.plan !== 'function' || typeof o.far.bind !== 'function'))
      throw new TypeError('Invalid terrain stream far ring; pass terrainFar(...) from @margoengine/terrain/far.');
    this.#o = o;
    const near = { tileSize: o.tileSize, tileTexels: o.tileTexels, window: o.window ?? 4 },
      far = o.far?.plan(near);
    // With a floating origin the camera is local: the windows are placed around its float64 world position.
    const local = engine.camera.position,
      shift = o.floatingOrigin?.origin,
      at = shift ? [local[0] + shift[0], local[1] + shift[1], local[2] + shift[2]] : local;
    const open = (size: typeof near, load: TerrainStreamLoad, weightArray: boolean): TileWindow =>
      new TileWindow(
        {
          ...size,
          lattice: [origin[0], origin[1]],
          load,
          weights: o.weights ?? 0,
          normals: !!o.normals,
          tint: !!o.tint,
          weightArray,
          fill: o.fill ?? 0,
          retries: o.retries ?? 2,
          retryDelay: o.retryDelay ?? 250,
          signal: o.signal,
        },
        at[0],
        at[2],
        () => this.terrain.invalidate(),
        () => this.#settle(),
      );
    this.#near = open(near, o.load, false);
    this.columns = this.#near.columns;
    this.heights = this.#near.heights;
    this.weights = this.#near.weights;
    this.normals = this.#near.normals;
    this.tint = this.#near.tint;
    if (far) this.far = this.#far = open(far, o.far!.load, true);
    const spacing = o.tileSize / o.tileTexels,
      side = (this.columns - 1) * spacing;
    const own = [
        'tileSize',
        'tileTexels',
        'window',
        'load',
        'colors',
        'weights',
        'budget',
        'concurrency',
        'fill',
        'signal',
        'retries',
        'retryDelay',
        'normals',
        'tint',
        'far',
      ],
      rest = Object.fromEntries(Object.entries(o).filter(([key]) => !own.includes(key))) as unknown as Omit<
        TerrainOptions,
        'textures' | 'origin' | 'size'
      >;
    // Rings enough to reach the far ring's edge: level L spans (resolution / 2) * cellSize * 2^(L - 1) from the eye,
    // less up to one of its cells of snapping.
    const rings = far && Math.ceil(Math.log2(far.reach / ((o.cellSize ?? 1) * ((o.resolution ?? 64) / 2 - 1)))) + 1;
    // The terrain reads `origin` every frame; the near window moves this array's values.
    this.terrain = new Terrain({
      ...rest,
      ...(rings && o.levels === undefined ? { levels: Math.min(12, Math.max(6, rings)) } : {}),
      clipmapAnchor: o.clipmapAnchor ?? 'camera',
      origin: this.#near.origin,
      size: [side, side],
      textures: this.#textures,
    });
    // Last: a far ring is taken only by a stream that was made.
    this.#ring = o.far?.bind(this.#near, this.#far!, o);
  }

  /**
   * Makes a streamed terrain on `engine` (WebGPU) around its camera and starts loading. Returns it; `dispose()`
   * removes it and its terrain.
   * @throws RangeError or TypeError for bad options (the terrain's own included); MargoError `'unsupported'` on WebGL.
   */
  static attach(engine: EngineKernel, options: TerrainStreamOptions): TerrainStream {
    const stream = new TerrainStream(engine, options),
      runtime = engineRuntime(engine);
    runtime.use(stream.terrain);
    runtime.use(stream);
    return stream;
  }

  /** World XZ of the window's first texel (the terrain's `origin`); moves by whole tiles. */
  get origin(): readonly [number, number] {
    return this.#near.origin;
  }
  /** Tile index of the window's minimum corner. */
  get tile(): readonly [number, number] {
    return this.#near.tile;
  }
  /** Rises on every change to the heightmap: an upload or a window move. */
  get version(): number {
    return this.#near.version;
  }
  /** Whether tile (x, z) is in the window and fully uploaded (loaded data, or no data at `fill`). */
  resident(x: number, z: number): boolean {
    return this.#near.resident(x, z);
  }
  /**
   * Starts every failed tile of the window (and of the far ring) over, and every tile waiting for a retry at once, each
   * with its full `retries` again (after the network comes back, say: `addEventListener('online', () =>
   * stream.retry())`). Returns how many tiles it started over; they load as frames are drawn.
   */
  retry(): number {
    return this.#near.retry() + (this.#far?.retry() ?? 0);
  }
  /**
   * Calls `callback` for every change to the heightmap, for a `TerrainQuery` over `heights`: refresh it over a band's
   * rectangle, or build a new one (`origin` moved) when `shifted`. Returns the remover. The far ring's changes come
   * from `far.onChange`.
   */
  onChange(callback: (change: TerrainStreamChange) => void): () => void {
    return this.#near.onChange(callback);
  }
  /**
   * Resolves once every tile of the current window, and of the far ring, is loaded and uploaded (uploads go in as frames
   * are drawn). Rejects with a tile's load error once its `retries` are spent, `signal`'s or the stream's abort reason,
   * or MargoError `'disposed'`.
   */
  ready(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const abort = () => {
          this.#waiters.delete(waiter);
          reject(signal!.reason);
        },
        waiter: Waiter = {
          resolve: () => (signal?.removeEventListener('abort', abort), resolve()),
          reject: (reason) => (signal?.removeEventListener('abort', abort), reject(reason)),
        };
      signal?.addEventListener('abort', abort, { once: true });
      this.#waiters.add(waiter);
      this.#settle();
    });
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Terrain streaming requires WebGPU and a live stream; attach a new TerrainStream to a WebGPU engine',
      );
    this.#engine = engine;
  }

  /** Follows the camera, loads and uploads; `delta`, the frame's seconds, drives the far ring's fades. */
  onPreUpdate(delta = 0): void {
    if (this.disposed || !this.#engine || !this.#attached) return;
    const p = this.#engine.camera.position,
      shift = this.#o.floatingOrigin ? this.terrain.shift : NO_SHIFT,
      x = p[0] + shift[0],
      z = p[2] + shift[2],
      near = this.#near,
      far = this.#far,
      at = near.follow(x, z),
      farAt = far?.follow(x, z),
      limit = this.#o.concurrency ?? 4,
      budget = this.#o.budget ?? 65536;
    // The far ring first: its tiles cover the most ground.
    far?.schedule(farAt![0], farAt![1], limit - far.loading - near.loading);
    near.schedule(at[0], at[1], limit - near.loading - (far?.loading ?? 0));
    near.upload(at[0], at[1], budget - (far?.upload(farAt![0], farAt![1], budget) ?? 0));
    if (this.#ring?.update(delta, x, z)) this.terrain.invalidate();
  }

  /** Settles `ready` waiters: rejected by a failed window tile or an aborted stream, resolved when all are resident. */
  #settle(): void {
    if (!this.#waiters.size) return;
    let reason: unknown,
      failed = false,
      missing = false;
    if (this.#o.signal?.aborted) (failed = true), (reason = this.#o.signal.reason);
    if (this.disposed)
      (failed = true), (reason = new MargoError('disposed', 'The terrain stream was disposed; attach a new one'));
    for (const window of this.#far ? [this.#near, this.#far] : [this.#near]) {
      const state = window.state();
      if (state.failed && !failed) (failed = true), (reason = state.failed.error);
      missing ||= state.missing;
    }
    if (!failed && missing) return;
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) failed ? waiter.reject(reason) : waiter.resolve();
  }

  /** The terrain's texture factory: the window from the CPU copies, at attachment and after device restoration. */
  #textures = (device: GPUDevice): TerrainTextures => {
    this.#near.create(device);
    this.#far?.destroyTextures();
    this.#far?.create(device);
    this.#attached = true;
    const t = this.#near.textures,
      w = t.weights,
      source = this.#ring?.source(device);
    return {
      heightmap: t.height,
      layers: this.#o.colors(device),
      ...(w.length ? { weights: w.length === 1 ? [w[0], w[0]] : w } : {}),
      ...(t.normals ? { normalmap: t.normals } : {}),
      ...(t.tint ? { tint: t.tint } : {}),
      ...(source ? { source } : {}),
    };
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#settle();
    this.#engine?.sceneOf(this)?.removePlugin(this.name);
    this.terrain.dispose();
    this.#ring?.dispose();
    this.#far?.destroyTextures();
    this.#near.dispose();
    this.#far?.dispose();
    this.#engine = undefined;
    this.#attached = false;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
