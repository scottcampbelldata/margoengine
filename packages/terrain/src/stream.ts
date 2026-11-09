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
// budget per frame, the nearest tile first, so a tile never stalls a frame.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { Terrain, type TerrainOptions, type TerrainTextures } from './index.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_SRC: number; COPY_DST: number };

/** One loaded tile: `tileTexels` x `tileTexels` samples, row by row along +X from the tile's minimum corner, rows along +Z. */
export interface TerrainStreamTile {
  /** Heights in heightmap units (world Y is `height * heightScale + heightOffset`), finite. */
  readonly heights: Float32Array;
  /**
   * With `TerrainStreamOptions.weights` above 0: that many arrays of RGBA bytes (4 per texel), the painted layer
   * weights of `TerrainTextures.weights` for this tile (layer i is channel i % 4 of array i / 4).
   */
  readonly weights?: readonly Uint8Array[];
}

/** What changed in the heightmap: a band of rows uploaded, or the whole window moved (`shifted`). Texel rectangle. */
export interface TerrainStreamChange {
  readonly shifted: boolean;
  readonly u: number;
  readonly v: number;
  readonly width: number;
  readonly depth: number;
}

/** {@link TerrainStream} options: the terrain's own options without `textures`, `origin` and `size`, plus these. */
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
   * for no data there (the tile keeps `fill`). `signal` aborts when the tile leaves the window or the stream is disposed.
   */
  readonly load: (x: number, z: number, signal: AbortSignal) => Promise<TerrainStreamTile | null | undefined>;
  /** Makes the layer colour array (`TerrainTextures.layers`), at attachment and again after device restoration. */
  readonly colors: (device: GPUDevice) => GPUTexture;
  /** Painted weight textures per tile, 0 to 4 (enough for the layers, 4 each). Default 0: the height and slope rules. */
  readonly weights?: number;
  /** Texels uploaded per frame (one tile row at least). Default 65,536 (one 256 x 256 tile). */
  readonly budget?: number;
  /** Tile loads in flight at once, 1 to 64. Default 4. */
  readonly concurrency?: number;
  /** Height of texels whose tile is not loaded yet, finite. Default 0. */
  readonly fill?: number;
  /** Aborts every load; no new ones start, and `ready` rejects with its reason. */
  readonly signal?: AbortSignal;
}

type Slot =
  | { state: 'loading'; controller: AbortController }
  | { state: 'queued'; tile: TerrainStreamTile; row: number }
  | { state: 'resident' }
  | { state: 'failed'; error: unknown };
interface Waiter {
  resolve(): void;
  reject(reason: unknown): void;
}

let nextId = 0;
const integer = (v: unknown, lo: number, hi: number): boolean =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/**
 * Moves rows and columns of an `n` x `n` image of `c` values per texel so texel (u, v) takes old (u + sx, v + sz);
 * texels with no source get `fill`. In place, in the order that reads each row before it is overwritten.
 */
const scroll = (a: Float32Array | Uint8Array, n: number, c: number, sx: number, sz: number, fill: number): void => {
  const u0 = Math.max(0, -sx),
    u1 = Math.min(n, n - sx);
  for (let k = 0; k < n; k++) {
    const v = sz >= 0 ? k : n - 1 - k,
      from = v + sz,
      row = v * n * c;
    if (from < 0 || from >= n || u1 <= u0) {
      a.fill(fill, row, row + n * c);
      continue;
    }
    a.copyWithin(row + u0 * c, (from * n + u0 + sx) * c, (from * n + u1 + sx) * c);
    a.fill(fill, row, row + u0 * c);
    a.fill(fill, row + u1 * c, row + n * c);
  }
};

/**
 * A {@link Terrain} whose heightmap (and painted weights) stream in tiles around the camera, so the world can be far
 * bigger than one heightmap. Attach with {@link TerrainStream.attach}; it makes and owns the terrain (`terrain`).
 * The window follows the engine camera: it moves a whole tile when the camera is more than 0.75 of a tile from its
 * centre, so ground at least `(window / 2 - 0.75) * tileSize` from the camera on each axis is always in it (the
 * terrain draws nothing past the window, as past any heightmap).
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
  disposed = false;
  readonly #o: TerrainStreamOptions;
  readonly #n: number;
  readonly #t: number;
  readonly #window: [number, number] = [0, 0];
  readonly #origin: [number, number] = [0, 0];
  readonly #slots = new Map<string, Slot>();
  readonly #waiters = new Set<Waiter>();
  readonly #listeners = new Set<(change: TerrainStreamChange) => void>();
  #engine?: Engine;
  #device?: GPUDevice;
  #height?: GPUTexture;
  #weightTextures: GPUTexture[] = [];
  #scratch?: GPUTexture;
  #scratchWeights?: GPUTexture;
  #fill?: GPUTexture;
  #fillWeights?: GPUTexture;
  #loading = 0;
  #version = 0;

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
      !Array.isArray(origin) ||
      !origin.every((v) => Number.isFinite(v))
    )
      throw new RangeError(
        'Invalid terrain stream options; give tileSize above 0, tileTexels 2..1024, an even window 2..16, weights 0..4 (4 layers each), budget and concurrency (1..64) whole numbers, and a finite fill and origin.',
      );
    this.#o = o;
    this.#t = o.tileTexels;
    this.#n = o.window ?? 4;
    this.columns = this.#n * this.#t;
    const texels = this.columns * this.columns;
    this.heights = new Float32Array(texels).fill(o.fill ?? 0);
    this.weights = Array.from({ length: o.weights ?? 0 }, () => new Uint8Array(texels * 4));
    const at = engine.camera.position;
    this.#place(
      Math.round((at[0] - origin[0]) / o.tileSize - this.#n / 2),
      Math.round((at[2] - origin[1]) / o.tileSize - this.#n / 2),
    );
    const spacing = o.tileSize / this.#t,
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
      ],
      rest = Object.fromEntries(Object.entries(o).filter(([key]) => !own.includes(key)));
    // The terrain reads `origin` every frame; the stream moves this array's values with the window.
    this.terrain = new Terrain({
      ...(rest as unknown as Omit<TerrainOptions, 'textures' | 'origin' | 'size'>),
      origin: this.#origin,
      size: [side, side],
      textures: this.#textures,
    });
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
    return this.#origin;
  }
  /** Tile index of the window's minimum corner. */
  get tile(): readonly [number, number] {
    return this.#window;
  }
  /** Rises on every change to the heightmap: an upload or a window move. */
  get version(): number {
    return this.#version;
  }
  /** Whether tile (x, z) is in the window and fully uploaded (loaded data, or no data at `fill`). */
  resident(x: number, z: number): boolean {
    return this.#slots.get(x + ',' + z)?.state === 'resident';
  }
  /**
   * Calls `callback` for every change to the heightmap, for a `TerrainQuery` over `heights`: refresh it over a band's
   * rectangle, or build a new one (`origin` moved) when `shifted`. Returns the remover.
   */
  onChange(callback: (change: TerrainStreamChange) => void): () => void {
    if (typeof callback !== 'function') throw new TypeError('Invalid terrain stream listener; pass a function.');
    this.#listeners.add(callback);
    return () => this.#listeners.delete(callback);
  }
  /**
   * Resolves once every tile of the current window is loaded and uploaded (uploads go in as frames are drawn).
   * Rejects with a tile's load error, `signal`'s or the stream's abort reason, or MargoError `'disposed'`.
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

  onPreUpdate(): void {
    if (this.disposed || !this.#engine || !this.#height) return;
    const p = this.#engine.camera.position,
      [ox, oz] = this.#o.origin ?? [0, 0],
      half = this.#n / 2,
      cx = (p[0] - ox) / this.#o.tileSize - this.#window[0] - half,
      cz = (p[2] - oz) / this.#o.tileSize - this.#window[1] - half;
    if (Number.isFinite(cx) && Number.isFinite(cz)) {
      const dx = Math.abs(cx) > 0.75 ? Math.round(cx) : 0,
        dz = Math.abs(cz) > 0.75 ? Math.round(cz) : 0;
      if (dx || dz) this.#shift(dx, dz);
    }
    const fx = this.#window[0] + half + (Number.isFinite(cx) ? cx : 0),
      fz = this.#window[1] + half + (Number.isFinite(cz) ? cz : 0);
    this.#schedule(fx, fz);
    this.#upload(fx, fz);
  }

  /** Sets the window's minimum tile and the terrain's origin to match. */
  #place(x: number, z: number): void {
    const [ox, oz] = this.#o.origin ?? [0, 0];
    this.#window[0] = x;
    this.#window[1] = z;
    this.#origin[0] = ox + x * this.#o.tileSize;
    this.#origin[1] = oz + z * this.#o.tileSize;
  }

  #inside(x: number, z: number): boolean {
    return (
      x >= this.#window[0] && z >= this.#window[1] && x < this.#window[0] + this.#n && z < this.#window[1] + this.#n
    );
  }

  /** Moves the window by (dx, dz) tiles: kept texels scroll on the CPU and the GPU, exposed tiles get `fill`. */
  #shift(dx: number, dz: number): void {
    const t = this.#t,
      n = this.columns,
      sx = dx * t,
      sz = dz * t;
    scroll(this.heights, n, 1, sx, sz, this.#o.fill ?? 0);
    for (const w of this.weights) scroll(w, n, 4, sx, sz, 0);
    this.#place(this.#window[0] + dx, this.#window[1] + dz);
    for (const [key, slot] of this.#slots) {
      const [x, z] = key.split(',').map(Number);
      if (this.#inside(x, z)) continue;
      if (slot.state === 'loading') slot.controller.abort();
      this.#slots.delete(key);
    }
    const device = this.#device!,
      encoder = device.createCommandEncoder(),
      width = n - Math.abs(sx),
      depth = n - Math.abs(sz),
      textures: [GPUTexture, GPUTexture, GPUTexture][] = [
        [this.#height!, this.#scratch!, this.#fill!],
        ...this.#weightTextures.map((w): [GPUTexture, GPUTexture, GPUTexture] => [
          w,
          this.#scratchWeights!,
          this.#fillWeights!,
        ]),
      ];
    for (const [texture, scratch, fill] of textures) {
      if (width > 0 && depth > 0) {
        const to = [Math.max(0, -sx), Math.max(0, -sz)];
        encoder.copyTextureToTexture(
          { texture, origin: [Math.max(0, sx), Math.max(0, sz)] },
          { texture: scratch, origin: to },
          [width, depth],
        );
        encoder.copyTextureToTexture({ texture: scratch, origin: to }, { texture, origin: to }, [width, depth]);
      }
      for (let j = 0; j < this.#n; j++)
        for (let i = 0; i < this.#n; i++) {
          const oi = i + dx,
            oj = j + dz;
          if (oi >= 0 && oj >= 0 && oi < this.#n && oj < this.#n) continue;
          encoder.copyTextureToTexture({ texture: fill }, { texture, origin: [i * t, j * t] }, [t, t]);
        }
    }
    // Submitted now, before this frame's band uploads (queue writes) land in the moved window.
    device.queue.submit([encoder.finish()]);
    this.#changed({ shifted: true, u: 0, v: 0, width: n, depth: n });
    this.#settle();
  }

  /** Starts loads for window tiles without one, nearest to (fx, fz) in tiles first. */
  #schedule(fx: number, fz: number): void {
    const o = this.#o,
      limit = o.concurrency ?? 4;
    if (this.#loading >= limit || this.#slots.size >= this.#n * this.#n || o.signal?.aborted) return;
    const wanted: [number, number, number][] = [];
    for (let j = 0; j < this.#n; j++)
      for (let i = 0; i < this.#n; i++) {
        const x = this.#window[0] + i,
          z = this.#window[1] + j;
        if (!this.#slots.has(x + ',' + z)) wanted.push([(x + 0.5 - fx) ** 2 + (z + 0.5 - fz) ** 2, x, z]);
      }
    wanted.sort((a, b) => a[0] - b[0]);
    for (const [, x, z] of wanted) {
      if (this.#loading >= limit) break;
      this.#start(x, z);
    }
  }

  #start(x: number, z: number): void {
    const key = x + ',' + z,
      controller = new AbortController(),
      slot: Slot = { state: 'loading', controller },
      signal = this.#o.signal ? AbortSignal.any([this.#o.signal, controller.signal]) : controller.signal;
    this.#slots.set(key, slot);
    this.#loading++;
    let loading: Promise<TerrainStreamTile | null | undefined>;
    try {
      loading = Promise.resolve(this.#o.load(x, z, signal));
    } catch (error) {
      loading = Promise.reject(error);
    }
    loading
      .then(
        (tile) => {
          if (this.#slots.get(key) !== slot || this.disposed) return;
          this.#slots.set(key, tile ? { state: 'queued', tile: this.#check(tile), row: 0 } : { state: 'resident' });
        },
        (error) => {
          if (this.#slots.get(key) !== slot || this.disposed) return;
          this.#slots.set(key, { state: 'failed', error });
        },
      )
      .catch((error) => {
        // A tile of the wrong shape counts as a failed load.
        if (this.#slots.get(key) === slot) this.#slots.set(key, { state: 'failed', error });
      })
      .finally(() => {
        this.#loading--;
        this.#settle();
      });
  }

  #check(tile: TerrainStreamTile): TerrainStreamTile {
    const texels = this.#t * this.#t,
      weights = this.weights.length;
    if (
      !(tile.heights instanceof Float32Array) ||
      tile.heights.length !== texels ||
      !tile.heights.every(Number.isFinite) ||
      (weights > 0 &&
        (!Array.isArray(tile.weights) ||
          tile.weights.length !== weights ||
          tile.weights.some((w) => !(w instanceof Uint8Array) || w.length !== texels * 4)))
    )
      throw new RangeError(
        `Invalid terrain stream tile; give ${texels} finite float32 heights and ${weights} weight arrays of ${texels * 4} bytes.`,
      );
    return tile;
  }

  /** Uploads bands of loaded tiles within the frame's texel budget, nearest to (fx, fz) first. */
  #upload(fx: number, fz: number): void {
    const t = this.#t,
      n = this.columns,
      queue = this.#device!.queue;
    let left = this.#o.budget ?? 65536,
      done = false;
    while (left > 0) {
      let best: { key: string; slot: Extract<Slot, { state: 'queued' }>; x: number; z: number } | undefined,
        distance = Infinity;
      for (const [key, slot] of this.#slots) {
        if (slot.state !== 'queued') continue;
        const [x, z] = key.split(',').map(Number),
          d = (x + 0.5 - fx) ** 2 + (z + 0.5 - fz) ** 2;
        if (d < distance) (distance = d), (best = { key, slot, x, z });
      }
      if (!best) break;
      const { slot, x, z } = best,
        j0 = slot.row,
        j1 = Math.min(t, j0 + Math.max(1, Math.floor(left / t))),
        u = (x - this.#window[0]) * t,
        v = (z - this.#window[1]) * t + j0,
        tile = slot.tile;
      for (let j = j0; j < j1; j++) {
        this.heights.set(tile.heights.subarray(j * t, (j + 1) * t), (v + j - j0) * n + u);
        this.weights.forEach((w, i) =>
          w.set(tile.weights![i].subarray(j * t * 4, (j + 1) * t * 4), ((v + j - j0) * n + u) * 4),
        );
      }
      queue.writeTexture(
        { texture: this.#height!, origin: [u, v] },
        tile.heights as Float32Array<ArrayBuffer>,
        { offset: j0 * t * 4, bytesPerRow: t * 4 },
        [t, j1 - j0],
      );
      this.#weightTextures.forEach((texture, i) =>
        queue.writeTexture(
          { texture, origin: [u, v] },
          tile.weights![i] as Uint8Array<ArrayBuffer>,
          { offset: j0 * t * 4, bytesPerRow: t * 4 },
          [t, j1 - j0],
        ),
      );
      left -= (j1 - j0) * t;
      slot.row = j1;
      if (j1 === t) {
        this.#slots.set(best.key, { state: 'resident' });
        done = true;
      }
      this.#changed({ shifted: false, u, v, width: t, depth: j1 - j0 });
    }
    if (done) this.#settle();
  }

  #changed(change: TerrainStreamChange): void {
    this.#version++;
    this.terrain.invalidate();
    for (const callback of [...this.#listeners]) callback(change);
  }

  /** Settles `ready` waiters: rejected by a failed window tile or an aborted stream, resolved when all are resident. */
  #settle(): void {
    if (!this.#waiters.size) return;
    let reason: unknown,
      failed = false,
      resident = 0;
    if (this.#o.signal?.aborted) (failed = true), (reason = this.#o.signal.reason);
    if (this.disposed)
      (failed = true), (reason = new MargoError('disposed', 'The terrain stream was disposed; attach a new one'));
    for (const slot of this.#slots.values())
      if (slot.state === 'failed' && !failed) (failed = true), (reason = slot.error);
      else if (slot.state === 'resident') resident++;
    if (!failed && resident < this.#n * this.#n) return;
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) failed ? waiter.reject(reason) : waiter.resolve();
  }

  /** The terrain's texture factory: the window from the CPU copies, at attachment and after device restoration. */
  #textures = (device: GPUDevice): TerrainTextures => {
    const n = this.columns,
      t = this.#t;
    if (n > device.limits.maxTextureDimension2D)
      throw new RangeError(
        `Terrain stream window of ${n} texels is above this device's 2D texture limit (${device.limits.maxTextureDimension2D}); use a smaller window or tileTexels.`,
      );
    this.#release();
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      copy = GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    this.#device = device;
    this.#height = device.createTexture({ size: [n, n], format: 'r32float', usage });
    device.queue.writeTexture(
      { texture: this.#height },
      this.heights as Float32Array<ArrayBuffer>,
      { bytesPerRow: n * 4 },
      [n, n],
    );
    this.#scratch = device.createTexture({ size: [n, n], format: 'r32float', usage: copy });
    this.#fill = device.createTexture({ size: [t, t], format: 'r32float', usage: copy });
    device.queue.writeTexture(
      { texture: this.#fill },
      new Float32Array(t * t).fill(this.#o.fill ?? 0),
      { bytesPerRow: t * 4 },
      [t, t],
    );
    this.#weightTextures = this.weights.map((data) => {
      const texture = device.createTexture({ size: [n, n], format: 'rgba8unorm', usage });
      device.queue.writeTexture({ texture }, data as Uint8Array<ArrayBuffer>, { bytesPerRow: n * 4 }, [n, n]);
      return texture;
    });
    if (this.weights.length) {
      this.#scratchWeights = device.createTexture({ size: [n, n], format: 'rgba8unorm', usage: copy });
      // New textures start at zero: no weight anywhere until a tile's weights arrive (layer 0 shows).
      this.#fillWeights = device.createTexture({ size: [t, t], format: 'rgba8unorm', usage: copy });
    }
    const w = this.#weightTextures;
    return {
      heightmap: this.#height,
      layers: this.#o.colors(device),
      ...(w.length ? { weights: w.length === 1 ? [w[0], w[0]] : w } : {}),
    };
  };

  /** Destroys the stream's own scratch and fill textures (the terrain owns and destroys the rest). */
  #release(): void {
    this.#scratch?.destroy();
    this.#scratchWeights?.destroy();
    this.#fill?.destroy();
    this.#fillWeights?.destroy();
    this.#scratch = this.#scratchWeights = this.#fill = this.#fillWeights = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.#slots.values()) if (slot.state === 'loading') slot.controller.abort();
    this.#settle();
    this.#slots.clear();
    this.#listeners.clear();
    this.#engine?.sceneOf(this)?.removePlugin(this.name);
    this.terrain.dispose();
    this.#release();
    this.#engine = this.#device = this.#height = undefined;
    this.#weightTextures = [];
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
