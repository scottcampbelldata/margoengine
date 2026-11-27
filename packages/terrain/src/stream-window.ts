// One window of streamed tiles around the camera: its CPU copies, textures, loads, retries, band uploads and whole-tile
// moves. `TerrainStream` (stream.ts) holds one for the heights it draws, and a second for its far ring
// (`@margoengine/terrain/far`), so both levels load, retry, scroll and restore the same way.
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
  /**
   * With `TerrainStreamOptions.normals`: the tile's normals as RGBA bytes (4 per texel), XYZ encoded 0..1 (`n * 0.5 +
   * 0.5`), the `TerrainTextures.normalmap` texels for this tile. Required on every tile with data then.
   */
  readonly normals?: Uint8Array;
  /**
   * With `TerrainStreamOptions.tint`: the tile's tint as RGBA bytes (4 per texel, sRGB colour and A how far tinted
   * layers move toward it), the `TerrainTextures.tint` texels for this tile. Optional: a tile without it is untinted.
   */
  readonly tint?: Uint8Array;
}

/** What changed in the heightmap: a band of rows uploaded, or the whole window moved (`shifted`). Texel rectangle. */
export interface TerrainStreamChange {
  readonly shifted: boolean;
  readonly u: number;
  readonly v: number;
  readonly width: number;
  readonly depth: number;
}

/** Loads tile (x, z); see `TerrainStreamOptions.load`. */
export type TerrainStreamLoad = (
  x: number,
  z: number,
  signal: AbortSignal,
) => Promise<TerrainStreamTile | null | undefined>;

/** The streamed tiles of one window: what `TerrainStream` and its far ring show of their data. */
export interface TerrainTiles {
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
  /** World XZ of the window's first texel; moves by whole tiles. */
  readonly origin: readonly [number, number];
  /** Tile index of the window's minimum corner. */
  readonly tile: readonly [number, number];
  /** Rises on every change to the heightmap: an upload or a window move. */
  readonly version: number;
  /** Whether tile (x, z) is in the window and fully uploaded (loaded data, or no data at `fill`). */
  resident(x: number, z: number): boolean;
  /** Calls `callback` for every change to the heightmap. Returns the remover. */
  onChange(callback: (change: TerrainStreamChange) => void): () => void;
}

/** What a window needs: `TerrainStreamOptions` with every default filled in. */
export interface TileWindowConfig {
  readonly tileSize: number;
  readonly tileTexels: number;
  readonly window: number;
  /** World XZ of tile (0, 0)'s minimum corner. */
  readonly lattice: readonly [number, number];
  readonly load: TerrainStreamLoad;
  readonly weights: number;
  readonly normals: boolean;
  readonly tint: boolean;
  /** The weight textures as the layers of one array texture. */
  readonly weightArray: boolean;
  readonly fill: number;
  readonly retries: number;
  readonly retryDelay: number;
  readonly signal?: AbortSignal;
}

/** One streamed RGBA8 texture beside the heights: a weight texture, the normal map or the tint. */
interface Plane {
  /** The CPU copy, `columns` x `columns` RGBA bytes. */
  readonly data: Uint8Array;
  /** What a texel holds before its tile loads. */
  readonly fill: readonly [number, number, number, number];
  readonly format: 'rgba8unorm' | 'rgba8unorm-srgb';
  /** The tile's bytes for this texture, or undefined for `fill`. */
  readonly pick: (tile: TerrainStreamTile) => Uint8Array | undefined;
  texture?: GPUTexture;
  /** The array layer of `texture` this plane writes. */
  layer: number;
  /** A `tileTexels` square of `fill`, copied over exposed tiles. */
  fillTexture?: GPUTexture;
  /** A tile of `fill` bytes, made the first time a tile without its own bytes is uploaded. */
  fillTile?: Uint8Array;
}

/** `count` texels of RGBA bytes, each `fill`. */
const filled = (count: number, fill: readonly number[]): Uint8Array => {
  const a = new Uint8Array(count * 4);
  for (let i = 0; i < a.length; i++) a[i] = fill[i % 4];
  return a;
};

type Slot =
  | { state: 'loading'; controller: AbortController }
  | { state: 'queued'; tile: TerrainStreamTile; row: number }
  | { state: 'resident'; data: boolean }
  | { state: 'failed'; error: unknown }
  | { state: 'waiting'; timer: ReturnType<typeof setTimeout> };

/**
 * Moves rows and columns of an `n` x `n` image of `c` values per texel so texel (u, v) takes old (u + sx, v + sz);
 * texels with no source get `fill`. In place, in the order that reads each row before it is overwritten.
 */
const scroll = (
  a: Float32Array | Uint8Array,
  n: number,
  c: number,
  sx: number,
  sz: number,
  fill: number | readonly number[],
): void => {
  // A per-texel fill (one value per channel) when the channels differ.
  const put = (from: number, to: number) => {
    if (typeof fill === 'number') a.fill(fill, from, to);
    else for (let i = from; i < to; i++) a[i] = fill[(i - from) % c];
  };
  const u0 = Math.max(0, -sx),
    u1 = Math.min(n, n - sx);
  for (let k = 0; k < n; k++) {
    const v = sz >= 0 ? k : n - 1 - k,
      from = v + sz,
      row = v * n * c;
    if (from < 0 || from >= n || u1 <= u0) {
      put(row, row + n * c);
      continue;
    }
    a.copyWithin(row + u0 * c, (from * n + u0 + sx) * c, (from * n + u1 + sx) * c);
    put(row, row + u0 * c);
    put(row + u1 * c, row + n * c);
  }
};

export class TileWindow implements TerrainTiles {
  readonly columns: number;
  readonly heights: Float32Array;
  readonly weights: readonly Uint8Array[];
  readonly normals?: Uint8Array;
  readonly tint?: Uint8Array;
  /** The arrays `tile` and `origin` return, moved in place with the window (the terrain reads `origin` every frame). */
  readonly tile: [number, number] = [0, 0];
  readonly origin: [number, number] = [0, 0];
  /** Loads in flight. */
  loading = 0;
  version = 0;
  readonly #c: TileWindowConfig;
  readonly #changedOwner: () => void;
  readonly #settle: () => void;
  readonly #slots = new Map<string, Slot>();
  /** Retries made so far per tile in the window, cleared when it loads, leaves the window or `retry()` runs. */
  readonly #attempts = new Map<string, number>();
  readonly #listeners = new Set<(change: TerrainStreamChange) => void>();
  #disposed = false;
  #device?: GPUDevice;
  #height?: GPUTexture;
  /** The weight textures, then the normal map and the tint when streamed. */
  readonly #planes: Plane[];
  #scratch?: GPUTexture;
  /** RGBA8 scratch for scrolling every plane (an `-srgb` plane copies through it too: the formats differ only in sRGB). */
  #scratchWeights?: GPUTexture;
  #fill?: GPUTexture;

  /** `x`, `z`: the world position the window is first placed around. `changed` and `settle` tell the owner. */
  constructor(config: TileWindowConfig, x: number, z: number, changed: () => void, settle: () => void) {
    const c = config;
    this.#c = c;
    this.#changedOwner = changed;
    this.#settle = settle;
    this.columns = c.window * c.tileTexels;
    const texels = this.columns * this.columns;
    this.heights = new Float32Array(texels).fill(c.fill);
    this.weights = Array.from({ length: c.weights }, () => new Uint8Array(texels * 4));
    // Unloaded normals face up: (0, 1, 0) encoded, 128 for 0 (0.502, as the shader decodes n * 2 - 1, off by 1/255).
    const up: [number, number, number, number] = [128, 255, 128, 255],
      none: [number, number, number, number] = [0, 0, 0, 0];
    this.#planes = this.weights.map(
      (data, i): Plane => ({ data, fill: none, format: 'rgba8unorm', layer: 0, pick: (tile) => tile.weights![i] }),
    );
    if (c.normals) {
      this.normals = filled(texels, up);
      this.#planes.push({ data: this.normals, fill: up, format: 'rgba8unorm', layer: 0, pick: (t) => t.normals });
    }
    if (c.tint) {
      this.tint = new Uint8Array(texels * 4);
      this.#planes.push({ data: this.tint, fill: none, format: 'rgba8unorm-srgb', layer: 0, pick: (t) => t.tint });
    }
    this.#place(
      Math.round((x - c.lattice[0]) / c.tileSize - c.window / 2),
      Math.round((z - c.lattice[1]) / c.tileSize - c.window / 2),
    );
  }

  /** The textures made by `create`: the heights, the weights (one entry per texture), the normal map and the tint. */
  get textures(): {
    height: GPUTexture;
    weights: GPUTexture[];
    normals?: GPUTexture;
    tint?: GPUTexture;
  } {
    const w = this.weights.length,
      planes = this.#planes;
    return {
      height: this.#height!,
      weights: planes.slice(0, w).map((plane) => plane.texture!),
      normals: this.normals ? planes[w].texture : undefined,
      tint: this.tint ? planes[planes.length - 1].texture : undefined,
    };
  }

  resident(x: number, z: number): boolean {
    return this.#slots.get(x + ',' + z)?.state === 'resident';
  }
  /** Whether tile (x, z) is resident with loaded data, not just `fill`. */
  holds(x: number, z: number): boolean {
    const slot = this.#slots.get(x + ',' + z);
    return slot?.state === 'resident' && slot.data;
  }

  onChange(callback: (change: TerrainStreamChange) => void): () => void {
    if (typeof callback !== 'function') throw new TypeError('Invalid terrain stream listener; pass a function.');
    this.#listeners.add(callback);
    return () => this.#listeners.delete(callback);
  }

  /** Starts every failed tile, and every tile waiting for a retry, over; returns how many. */
  retry(): number {
    let count = 0;
    for (const [key, slot] of this.#slots)
      if (slot.state === 'failed' || slot.state === 'waiting') {
        if (slot.state === 'waiting') clearTimeout(slot.timer);
        this.#slots.delete(key);
        this.#attempts.delete(key);
        count++;
      }
    return count;
  }

  /** Whether some tile of the window is not resident yet, and the first failed tile's error as `failed`. */
  state(): { missing: boolean; failed?: { error: unknown } } {
    let resident = 0,
      failed: { error: unknown } | undefined;
    for (const slot of this.#slots.values())
      if (slot.state === 'failed') failed ??= { error: slot.error };
      else if (slot.state === 'resident') resident++;
    return { missing: resident < this.#c.window ** 2, failed };
  }

  /**
   * Moves the window a whole tile or more when world (x, z) is more than 0.75 of a tile from its centre. Returns
   * (x, z) in tiles from the lattice, the window's centre for a position that is not finite.
   */
  follow(x: number, z: number): [number, number] {
    const c = this.#c,
      half = c.window / 2,
      cx = (x - c.lattice[0]) / c.tileSize - this.tile[0] - half,
      cz = (z - c.lattice[1]) / c.tileSize - this.tile[1] - half;
    if (Number.isFinite(cx) && Number.isFinite(cz)) {
      const dx = Math.abs(cx) > 0.75 ? Math.round(cx) : 0,
        dz = Math.abs(cz) > 0.75 ? Math.round(cz) : 0;
      if (dx || dz) this.#shift(dx, dz);
      return [this.tile[0] + half + cx - dx, this.tile[1] + half + cz - dz];
    }
    return [this.tile[0] + half, this.tile[1] + half];
  }

  /** Sets the window's minimum tile and world origin. */
  #place(x: number, z: number): void {
    const c = this.#c;
    this.tile[0] = x;
    this.tile[1] = z;
    this.origin[0] = c.lattice[0] + x * c.tileSize;
    this.origin[1] = c.lattice[1] + z * c.tileSize;
  }

  #inside(x: number, z: number): boolean {
    const n = this.#c.window;
    return x >= this.tile[0] && z >= this.tile[1] && x < this.tile[0] + n && z < this.tile[1] + n;
  }

  /** Moves the window by (dx, dz) tiles: kept texels scroll on the CPU and the GPU, exposed tiles get `fill`. */
  #shift(dx: number, dz: number): void {
    const t = this.#c.tileTexels,
      count = this.#c.window,
      n = this.columns,
      sx = dx * t,
      sz = dz * t;
    scroll(this.heights, n, 1, sx, sz, this.#c.fill);
    for (const plane of this.#planes) scroll(plane.data, n, 4, sx, sz, plane.fill);
    this.#place(this.tile[0] + dx, this.tile[1] + dz);
    for (const [key, slot] of this.#slots) {
      const [x, z] = key.split(',').map(Number);
      if (this.#inside(x, z)) continue;
      if (slot.state === 'loading') slot.controller.abort();
      if (slot.state === 'waiting') clearTimeout(slot.timer);
      this.#slots.delete(key);
      this.#attempts.delete(key);
    }
    const device = this.#device!,
      encoder = device.createCommandEncoder(),
      width = n - Math.abs(sx),
      depth = n - Math.abs(sz),
      textures: [GPUTexture, number, GPUTexture, GPUTexture][] = [
        [this.#height!, 0, this.#scratch!, this.#fill!],
        ...this.#planes.map((plane): [GPUTexture, number, GPUTexture, GPUTexture] => [
          plane.texture!,
          plane.layer,
          this.#scratchWeights!,
          plane.fillTexture!,
        ]),
      ];
    for (const [texture, layer, scratch, fill] of textures) {
      if (width > 0 && depth > 0) {
        const to = [Math.max(0, -sx), Math.max(0, -sz)];
        encoder.copyTextureToTexture(
          { texture, origin: [Math.max(0, sx), Math.max(0, sz), layer] },
          { texture: scratch, origin: to },
          [width, depth],
        );
        encoder.copyTextureToTexture({ texture: scratch, origin: to }, { texture, origin: [to[0], to[1], layer] }, [
          width,
          depth,
        ]);
      }
      for (let j = 0; j < count; j++)
        for (let i = 0; i < count; i++) {
          const oi = i + dx,
            oj = j + dz;
          if (oi >= 0 && oj >= 0 && oi < count && oj < count) continue;
          encoder.copyTextureToTexture({ texture: fill }, { texture, origin: [i * t, j * t, layer] }, [t, t]);
        }
    }
    // Submitted now, before this frame's band uploads (queue writes) land in the moved window.
    device.queue.submit([encoder.finish()]);
    this.#changed({ shifted: true, u: 0, v: 0, width: n, depth: n });
    this.#settle();
  }

  /** Starts up to `free` loads for window tiles without one, nearest to (fx, fz) in tiles first. */
  schedule(fx: number, fz: number, free: number): void {
    const n = this.#c.window;
    if (free <= 0 || this.#slots.size >= n * n || this.#c.signal?.aborted) return;
    const wanted: [number, number, number][] = [];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = this.tile[0] + i,
          z = this.tile[1] + j;
        if (!this.#slots.has(x + ',' + z)) wanted.push([(x + 0.5 - fx) ** 2 + (z + 0.5 - fz) ** 2, x, z]);
      }
    wanted.sort((a, b) => a[0] - b[0]);
    for (const [, x, z] of wanted) {
      if (free-- <= 0) break;
      this.#start(x, z);
    }
  }

  #start(x: number, z: number): void {
    const key = x + ',' + z,
      controller = new AbortController(),
      slot: Slot = { state: 'loading', controller },
      signal = this.#c.signal ? AbortSignal.any([this.#c.signal, controller.signal]) : controller.signal;
    this.#slots.set(key, slot);
    this.loading++;
    let loading: Promise<TerrainStreamTile | null | undefined>;
    try {
      loading = Promise.resolve(this.#c.load(x, z, signal));
    } catch (error) {
      loading = Promise.reject(error);
    }
    loading
      .then(
        (tile) => {
          if (this.#slots.get(key) !== slot || this.#disposed) return;
          this.#attempts.delete(key);
          this.#slots.set(
            key,
            tile ? { state: 'queued', tile: this.#check(tile), row: 0 } : { state: 'resident', data: false },
          );
        },
        (error) => {
          if (this.#slots.get(key) !== slot || this.#disposed) return;
          this.#failed(key, error, signal.aborted);
        },
      )
      .catch((error) => {
        // A tile of the wrong shape counts as a failed load.
        if (this.#slots.get(key) === slot) this.#slots.set(key, { state: 'failed', error });
      })
      .finally(() => {
        this.loading--;
        this.#settle();
      });
  }

  /**
   * A load of tile `key` rejected: waits and frees the slot for `schedule` to load it again while retries are left (never
   * for an aborted load), else marks it failed. Retry k waits a random time up to retryDelay * 2^k, capped at 30 s
   * (exponential backoff with full jitter).
   */
  #failed(key: string, error: unknown, aborted: boolean): void {
    const done = this.#attempts.get(key) ?? 0;
    if (aborted || done >= this.#c.retries) {
      this.#slots.set(key, { state: 'failed', error });
      return;
    }
    this.#attempts.set(key, done + 1);
    const wait = Math.random() * Math.min(30_000, this.#c.retryDelay * 2 ** done),
      slot: Slot = {
        state: 'waiting',
        timer: setTimeout(() => {
          if (this.#slots.get(key) === slot) this.#slots.delete(key);
        }, wait),
      };
    this.#slots.set(key, slot);
  }

  #check(tile: TerrainStreamTile): TerrainStreamTile {
    const t = this.#c.tileTexels,
      texels = t * t,
      weights = this.weights.length,
      bytes = (b: unknown) => b instanceof Uint8Array && b.length === texels * 4;
    if (
      !(tile.heights instanceof Float32Array) ||
      tile.heights.length !== texels ||
      !tile.heights.every(Number.isFinite) ||
      (weights > 0 &&
        (!Array.isArray(tile.weights) || tile.weights.length !== weights || tile.weights.some((w) => !bytes(w)))) ||
      (this.normals && !bytes(tile.normals)) ||
      (tile.tint !== undefined && (!this.tint || !bytes(tile.tint)))
    )
      throw new RangeError(
        `Invalid terrain stream tile; give ${texels} finite float32 heights, ${weights} weight arrays of ${texels * 4} bytes` +
          (this.normals ? `, normals of ${texels * 4} bytes` : '') +
          (this.tint
            ? ` and, if any, a tint of ${texels * 4} bytes.`
            : ' and no tint (the stream has no tint option).'),
      );
    return tile;
  }

  /** Uploads bands of loaded tiles within `budget` texels, nearest to (fx, fz) first; returns the texels uploaded. */
  upload(fx: number, fz: number, budget: number): number {
    const t = this.#c.tileTexels,
      n = this.columns,
      queue = this.#device!.queue;
    let left = budget,
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
        u = (x - this.tile[0]) * t,
        v = (z - this.tile[1]) * t + j0,
        tile = slot.tile;
      for (let j = j0; j < j1; j++) {
        this.heights.set(tile.heights.subarray(j * t, (j + 1) * t), (v + j - j0) * n + u);
        for (const plane of this.#planes) {
          const from = plane.pick(tile),
            at = ((v + j - j0) * n + u) * 4;
          if (from) plane.data.set(from.subarray(j * t * 4, (j + 1) * t * 4), at);
          else for (let i = 0; i < t * 4; i++) plane.data[at + i] = plane.fill[i % 4];
        }
      }
      queue.writeTexture(
        { texture: this.#height!, origin: [u, v] },
        tile.heights as Float32Array<ArrayBuffer>,
        { offset: j0 * t * 4, bytesPerRow: t * 4 },
        [t, j1 - j0],
      );
      for (const plane of this.#planes)
        queue.writeTexture(
          { texture: plane.texture!, origin: [u, v, plane.layer] },
          (plane.pick(tile) ?? (plane.fillTile ??= filled(t * t, plane.fill))) as Uint8Array<ArrayBuffer>,
          { offset: j0 * t * 4, bytesPerRow: t * 4 },
          [t, j1 - j0],
        );
      left -= (j1 - j0) * t;
      slot.row = j1;
      if (j1 === t) {
        this.#slots.set(best.key, { state: 'resident', data: true });
        done = true;
      }
      this.#changed({ shifted: false, u, v, width: t, depth: j1 - j0 });
    }
    if (done) this.#settle();
    return budget - left;
  }

  #changed(change: TerrainStreamChange): void {
    this.version++;
    this.#changedOwner();
    for (const callback of [...this.#listeners]) callback(change);
  }

  /** Makes the textures on `device` from the CPU copies, at attachment and after device restoration. */
  create(device: GPUDevice): void {
    const n = this.columns,
      t = this.#c.tileTexels;
    if (n > device.limits.maxTextureDimension2D)
      throw new RangeError(
        `Terrain stream window of ${n} texels is above this device's 2D texture limit (${device.limits.maxTextureDimension2D}); use a smaller window or tileTexels.`,
      );
    this.release();
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
      new Float32Array(t * t).fill(this.#c.fill),
      { bytesPerRow: t * 4 },
      [t, t],
    );
    const layers = this.#c.weightArray ? this.weights.length : 0;
    let array: GPUTexture | undefined;
    for (let i = 0; i < this.#planes.length; i++) {
      const plane = this.#planes[i];
      plane.layer = i < layers ? i : 0;
      // The view dimension is declared for compatibility mode, which binds a one-layer texture as 2D otherwise.
      plane.texture =
        i < layers
          ? (array ??= device.createTexture({
              size: [n, n, layers],
              format: plane.format,
              usage,
              textureBindingViewDimension: '2d-array',
            } as GPUTextureDescriptor))
          : device.createTexture({ size: [n, n], format: plane.format, usage });
      device.queue.writeTexture(
        { texture: plane.texture, origin: [0, 0, plane.layer] },
        plane.data as Uint8Array<ArrayBuffer>,
        { bytesPerRow: n * 4 },
        [n, n],
      );
      plane.fillTexture = device.createTexture({ size: [t, t], format: plane.format, usage: copy });
      device.queue.writeTexture(
        { texture: plane.fillTexture },
        filled(t * t, plane.fill) as Uint8Array<ArrayBuffer>,
        { bytesPerRow: t * 4 },
        [t, t],
      );
    }
    if (this.#planes.length)
      this.#scratchWeights = device.createTexture({ size: [n, n], format: 'rgba8unorm', usage: copy });
  }

  /** Destroys the window's own scratch and fill textures (a terrain given the others owns and destroys them). */
  release(): void {
    this.#scratch?.destroy();
    this.#scratchWeights?.destroy();
    for (const plane of this.#planes) plane.fillTexture?.destroy();
    this.#fill?.destroy();
    this.#scratch = this.#scratchWeights = this.#fill = undefined;
    for (const plane of this.#planes) plane.fillTexture = undefined;
  }

  /** Destroys the heightmap and planes too: for a window whose textures no terrain owns (the far ring). */
  destroyTextures(): void {
    this.#height?.destroy();
    for (const plane of this.#planes) plane.texture?.destroy();
  }

  dispose(): void {
    this.#disposed = true;
    for (const slot of this.#slots.values())
      if (slot.state === 'loading') slot.controller.abort();
      else if (slot.state === 'waiting') clearTimeout(slot.timer);
    this.#slots.clear();
    this.#attempts.clear();
    this.#listeners.clear();
    this.release();
    this.#device = this.#height = undefined;
    for (const plane of this.#planes) plane.texture = undefined;
  }
}
