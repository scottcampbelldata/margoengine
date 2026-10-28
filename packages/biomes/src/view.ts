/// <reference lib="esnext.disposable" preserve="true" />
// BiomeView part 1 (spec 4, B3): a biome world drawn as clipmap terrain. Heights and per-material ground weights go
// into `@margoengine/terrain` (its optional `TerrainTextures.weights`, decision D4): an overview from the region grid
// first, then 1 m tiles around the camera, nearest first, and again for every dirty rectangle the world reports (so
// painting shows up). Terrain is loaded with import() on attach, so this entry costs nothing until it is used.
// Ground layer rules use the same Wendland bands as biome envelopes (define.ts); materials are generated textures.
import type { EngineKernel } from '@margoengine/core';
import type { Terrain, TerrainColorOptions } from '@margoengine/terrain';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { type BiomeDefinition, type Dimension, fieldDimension } from './define.js';
// The toolkit comes through the package name, so the view shares the root's copy (a view always has a world).
import { clampInt, divFloor, hash3, ONE, wendland } from '@margoengine/biomes/toolkit';
import type { BiomeTile, BiomeWorld } from './world.js';

/** The look of a ground material: sRGB colour 0..1 and the contrast of its generated detail 0..1. */
export interface MaterialLook {
  readonly color: readonly [number, number, number];
  /** Default 0.25. */
  readonly detail?: number;
}

/** Built-in material looks, by key (the materials the presets use). Unknown keys get a neutral grey-brown. */
export const MATERIALS: Readonly<Record<string, MaterialLook>> = Object.freeze({
  grass: { color: [0.29, 0.42, 0.16] },
  meadow: { color: [0.42, 0.5, 0.22] },
  'leaf-litter': { color: [0.36, 0.27, 0.16] },
  needles: { color: [0.33, 0.24, 0.15] },
  moss: { color: [0.24, 0.35, 0.14] },
  mud: { color: [0.25, 0.2, 0.15], detail: 0.15 },
  sand: { color: [0.82, 0.72, 0.5], detail: 0.12 },
  'red-sand': { color: [0.74, 0.45, 0.27], detail: 0.12 },
  'dry-grass': { color: [0.66, 0.58, 0.33] },
  laterite: { color: [0.6, 0.33, 0.2] },
  rock: { color: [0.45, 0.43, 0.4], detail: 0.35 },
  scree: { color: [0.55, 0.53, 0.5], detail: 0.4 },
  gravel: { color: [0.52, 0.5, 0.46], detail: 0.4 },
  snow: { color: [0.92, 0.94, 0.97], detail: 0.05 },
  tundra: { color: [0.45, 0.43, 0.3] },
  heather: { color: [0.45, 0.3, 0.38] },
});

/** Settings of {@link BiomeView.attach}. */
export interface BiomeViewOptions {
  /** Metres per heightmap and weights texel, a multiple of the world resolution. Default 2 (raised when the world
   * would exceed the device's largest 2D texture). */
  readonly textureResolution?: number;
  /** Tiles within this distance of the camera are drawn at full detail, nearest first. Default 1,000 m. */
  readonly radius?: number;
  /** Material looks by key, over `MATERIALS`. Default none. */
  readonly materials?: Readonly<Record<string, MaterialLook>>;
  /** Clipmap settings passed to the terrain. Default cell 1 m, 64 cells per ring, 6 rings. */
  readonly clipmap?: { readonly cellSize?: number; readonly resolution?: number; readonly levels?: number };
  /** Rejects `attach` and stops streaming when aborted. */
  readonly signal?: AbortSignal;
}

/** Ground material keys of a biome list in first-use order, at most 8 (the terrain's layer limit). */
export function groundMaterials(biomes: readonly BiomeDefinition[]): string[] {
  const keys: string[] = [];
  for (const b of biomes)
    for (const g of b.ground) if (!keys.includes(g.material) && keys.length < 8) keys.push(g.material);
  return keys;
}

/** Per biome, per ground layer: material index, quantised rule and weight (Q16). */
type Rules = readonly (readonly { material: number; dims: readonly Dimension[]; weight: number }[])[];

function rulesOf(biomes: readonly BiomeDefinition[], materials: readonly string[]): Rules {
  return biomes.map((b) =>
    b.ground.map((g) => ({
      material: Math.max(0, materials.indexOf(g.material)),
      dims: (['slope', 'height', 'moisture', 'curvature'] as const)
        .filter((k) => g[k] !== undefined)
        .map((k) => fieldDimension(k, g[k]!)),
      weight: Math.round((g.weight ?? 1) * ONE),
    })),
  );
}

/**
 * Ground material weights of a tile: 8 bytes per cell (materials 0..7, `groundMaterials` order) summing to 255. Each of
 * the cell's biomes shares its weight among its ground layers by their rules (Wendland bands like envelopes; a biome
 * whose rules all miss uses its first layer). Integer only.
 */
export function groundWeights(world: BiomeWorld, tile: BiomeTile, materials: readonly string[]): Uint8Array {
  const rules = rulesOf(world.biomes, materials),
    n = tile.cells * tile.cells,
    out = new Uint8Array(n * 8),
    ids = tile.layer('biome')?.data,
    weights = tile.layer('biomeWeight')?.data;
  if (!ids || !weights) throw typeError('groundWeights needs a tile with the biome and biomeWeight layers', 'biomes');
  const data: Record<string, ArrayLike<number>> = {};
  for (const name of ['slope', 'height', 'moisture', 'curvature'])
    data[name] = tile.layer(name)?.data ?? new Int32Array(n);
  const sums = new Int32Array(8),
    share = new Int32Array(8);
  for (let k = 0; k < n; k++) {
    sums.fill(0);
    for (let s = 0; s < 4; s++) {
      const w = weights[k * 4 + s];
      if (!w) continue;
      const layers = rules[ids[k * 4 + s]];
      let total = 0;
      for (const g of layers) {
        let m = g.weight;
        for (const d of g.dims) {
          const v = data[d.layer][k],
            dist = Math.max(d.lo - v, v - d.hi);
          m = Math.floor((m * wendland(clampInt(divFloor((dist + (d.width >> 1)) * ONE, d.width), 0, ONE))) / ONE);
        }
        share[g.material] += m;
        total += m;
      }
      if (!total) share[layers[0].material] = total = ONE;
      for (let i = 0; i < 8; i++) {
        sums[i] += divFloor(share[i] * w, total);
        share[i] = 0;
      }
    }
    quantise(sums, out, k * 8);
  }
  return out;
}

/** Writes 8 weights proportional to `w` summing to 255 (largest remainder, ties by index). */
function quantise(w: Int32Array, out: Uint8Array, at: number): void {
  let total = 0;
  for (let i = 0; i < 8; i++) total += w[i];
  if (!total) {
    out[at] = 255;
    return;
  }
  let given = 0;
  for (let i = 0; i < 8; i++) {
    out[at + i] = divFloor(w[i] * 255, total);
    given += out[at + i];
  }
  for (let left = 255 - given; left > 0; left--) {
    let best = 0,
      rem = -1;
    for (let i = 0; i < 8; i++) {
      const r = w[i] * 255 - out[at + i] * total;
      if (r > rem) [best, rem] = [i, r];
    }
    out[at + best]++;
    w[best] -= total;
  }
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const look = (key: string, extra?: Readonly<Record<string, MaterialLook>>): MaterialLook =>
  extra?.[key] ?? MATERIALS[key] ?? { color: [0.4, 0.36, 0.3] };

/**
 * `TerrainColors` options from the world's most common ground materials, for small scenes drawn as one heightfield
 * mesh: sand from the lowest-lying sandy or muddy material, meadow from the two first plant cover materials, stone
 * from rock. Linear RGB, as `TerrainColors` takes.
 */
export function terrainColorsFor(
  world: BiomeWorld,
  materials?: Readonly<Record<string, MaterialLook>>,
): Pick<TerrainColorOptions, 'sand' | 'meadow' | 'stone'> {
  const keys = groundMaterials(world.biomes),
    linear = (key: string) => look(key, materials).color.map(srgbToLinear) as unknown as [number, number, number],
    pick = (want: readonly string[], fallback: string) => keys.find((k) => want.includes(k)) ?? fallback,
    plants = keys.filter((k) => !['rock', 'scree', 'gravel', 'sand', 'red-sand', 'mud', 'snow'].includes(k));
  return {
    sand: linear(pick(['sand', 'red-sand', 'mud', 'gravel'], 'sand')),
    meadow: [linear(plants[0] ?? 'grass'), linear(plants[1] ?? plants[0] ?? 'meadow')],
    stone: linear(pick(['rock', 'scree', 'gravel'], 'rock')),
  };
}

/** A generated material texture (256 x 256 RGBA8, sRGB bytes) with mip levels, from value noise. */
function materialPixels(key: string, m: MaterialLook): Uint8Array[] {
  const size = 256,
    base = new Uint8Array(size * size * 4),
    detail = m.detail ?? 0.25,
    seed = hash3(0x6d61, key.length, key.charCodeAt(0) * 31 + key.charCodeAt(key.length - 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      // Two octaves of tileable lattice noise (16 and 64 cells over the texture).
      const n = (cellNoise(seed, x, y, 16) * 2 + cellNoise(seed + 1, x, y, 64)) / 3 - 0.5, // float division: view only
        k = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) base[k + c] = clampInt(Math.round(m.color[c] * 255 * (1 + detail * n * 2)), 0, 255);
      base[k + 3] = 255;
    }
  const levels = [base];
  for (let s = size >> 1; s >= 1; s >>= 1) {
    const prev = levels[levels.length - 1],
      next = new Uint8Array(s * s * 4),
      w = s * 2;
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++)
        for (let c = 0; c < 4; c++) {
          const a = (2 * y * w + 2 * x) * 4 + c;
          next[(y * s + x) * 4 + c] = (prev[a] + prev[a + 4] + prev[a + w * 4] + prev[a + w * 4 + 4] + 2) >> 2;
        }
    levels.push(next);
  }
  return levels;
}

/** Tileable value noise in 0..1 on a `cells` x `cells` lattice over a 256-texel square. */
function cellNoise(seed: number, x: number, y: number, cells: number): number {
  const step = 256 / cells, // float division: view only
    fx = x / step, // float division
    fy = y / step, // float division
    ix = Math.floor(fx),
    iy = Math.floor(fy),
    tx = fx - ix,
    ty = fy - iy,
    v = (i: number, j: number) =>
      (hash3(seed, ((i % cells) + cells) % cells, ((j % cells) + cells) % cells) >>> 8) / 16777216, // float division
    sx = tx * tx * (3 - 2 * tx),
    sy = ty * ty * (3 - 2 * ty),
    a = v(ix, iy) + (v(ix + 1, iy) - v(ix, iy)) * sx,
    b = v(ix, iy + 1) + (v(ix + 1, iy + 1) - v(ix, iy + 1)) * sx;
  return a + (b - a) * sy;
}

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/**
 * A biome world drawn as terrain: heights and ground materials from the world, streamed around the camera at full
 * detail and redrawn where the world changes (paint, edits). WebGPU only (the terrain package draws it).
 * `using view = await BiomeView.attach(engine, world)` frees it at the end of a block.
 * @example
 * const view = await BiomeView.attach(engine, world);
 * await view.ready; // the tiles around the camera are in
 */
export class BiomeView implements Disposable {
  /** The terrain the view draws through (`shadows.add(view.terrain)` works as for any terrain). */
  readonly terrain: Terrain;
  /** Ground material keys, in terrain layer order. */
  readonly materials: readonly string[];
  /** Resolves once the tiles around the camera are drawn at full detail. */
  readonly ready: Promise<void>;
  /** Metres per heightmap and weights texel. */
  readonly textureResolution: number;
  readonly #world: BiomeWorld;
  readonly #engine: EngineKernel;
  readonly #width: number;
  readonly #depth: number;
  readonly #heights: Float32Array;
  readonly #weights: [Uint8Array, Uint8Array];
  readonly #radius: number;
  readonly #signal?: AbortSignal;
  #textures?: { device: GPUDevice; height: GPUTexture; weights: [GPUTexture, GPUTexture] };
  #queue: Promise<void> = Promise.resolve();
  #off: () => void;
  #disposed = false;

  private constructor(
    engine: EngineKernel,
    world: BiomeWorld,
    options: BiomeViewOptions,
    terrainModule: typeof import('@margoengine/terrain'),
    limit: number,
  ) {
    this.#engine = engine;
    this.#world = world;
    this.#signal = options.signal;
    this.#radius = options.radius ?? 1000;
    const [x0, z0, x1, z1] = world.bounds;
    let texel = options.textureResolution ?? 2;
    const steps = texel / world.resolution; // float division: option check
    if (!(texel > 0) || Math.round(steps) * world.resolution !== texel)
      throw rangeError('BiomeView textureResolution must be a positive multiple of the world resolution', 'biomes');
    if (!(this.#radius > 0)) throw rangeError('BiomeView radius must be above 0', 'biomes');
    while ((x1 - x0) / texel + 1 > limit || (z1 - z0) / texel + 1 > limit) texel *= 2; // float division
    this.textureResolution = texel;
    this.#width = Math.round((x1 - x0) / texel) + 1; // float division: exact
    this.#depth = Math.round((z1 - z0) / texel) + 1; // float division
    this.materials = Object.freeze(groundMaterials(world.biomes));
    const looks = this.materials.map((key) => look(key, options.materials)),
      // The terrain needs 4 to 8 layers: repeat the last material when there are fewer.
      layerKeys = [...this.materials];
    while (layerKeys.length < 4) layerKeys.push(layerKeys[layerKeys.length - 1]);
    const pixels = layerKeys.map((key, i) => materialPixels(key, looks[Math.min(i, looks.length - 1)]));
    this.#heights = this.#overviewHeights();
    this.#weights = [new Uint8Array(this.#width * this.#depth * 4), new Uint8Array(this.#width * this.#depth * 4)];
    this.#overviewWeights();
    const view = this;
    this.terrain = terrainModule.Terrain.attach(engine, {
      origin: [x0, z0],
      size: [x1 - x0, z1 - z0],
      heightScale: 1,
      cellSize: options.clipmap?.cellSize ?? 1,
      resolution: options.clipmap?.resolution ?? 64,
      levels: options.clipmap?.levels ?? 6,
      // Weights replace the rules; the rules only set each material's texture repeat (4 m).
      layers: layerKeys.map(() => ({ height: [-1e6, 1e6] as const, slope: [0, 1] as const, scale: 0.25 })),
      textures(device) {
        const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          size = [view.#width, view.#depth],
          height = device.createTexture({ size, format: 'r32float', usage }),
          weights = [0, 1].map(() => device.createTexture({ size, format: 'rgba8unorm', usage })) as [
            GPUTexture,
            GPUTexture,
          ],
          layers = device.createTexture({
            size: [256, 256, layerKeys.length],
            format: 'rgba8unorm-srgb',
            usage,
            mipLevelCount: 9,
          });
        pixels.forEach((levels, layer) =>
          levels.forEach((data, mip) => {
            const s = 256 >> mip;
            device.queue.writeTexture(
              { texture: layers, mipLevel: mip, origin: [0, 0, layer] },
              data as Uint8Array<ArrayBuffer>,
              { bytesPerRow: s * 4, rowsPerImage: s },
              [s, s, 1],
            );
          }),
        );
        view.#textures = { device, height, weights };
        view.#upload(0, 0, view.#width, view.#depth);
        return { heightmap: height, layers, weights };
      },
    });
    this.#off = world.onChange((rect) => this.#enqueue(rect));
    this.ready = this.#enqueue(this.#around());
  }

  /**
   * Draws a biome world as terrain on a WebGPU engine. Loads `@margoengine/terrain` on first use.
   * @throws MargoError `'unsupported'` on a WebGL engine; RangeError for bad options. Rejects with the signal's reason.
   */
  static async attach(engine: EngineKernel, world: BiomeWorld, options: BiomeViewOptions = {}): Promise<BiomeView> {
    if (!engine || !world || typeof world.tile !== 'function')
      throw typeError('BiomeView.attach takes an engine and a BiomeWorld', 'biomes');
    if (engine.backend !== 'webgpu')
      throw fault('unsupported', 'BiomeView needs a WebGPU engine; create the engine with WebGPU', 'biomes');
    if (options.signal?.aborted) throw options.signal.reason;
    const terrainModule = await import('@margoengine/terrain');
    if (options.signal?.aborted) throw options.signal.reason;
    const limit = (engine as unknown as { gpu?: GPUDevice }).gpu?.limits.maxTextureDimension2D ?? 8192;
    return new BiomeView(engine, world, options, terrainModule, limit);
  }

  /** The world rectangle around the camera that is drawn at full detail. */
  #around(): readonly [number, number, number, number] {
    const p = this.#engine.camera.position,
      r = this.#radius;
    return [p[0] - r, p[2] - r, p[0] + r, p[2] + r];
  }

  /** Heights from the world's region overview, bilinear to the texel grid. */
  #overviewHeights(): Float32Array {
    const o = this.#world.overview(),
      out = new Float32Array(this.#width * this.#depth),
      ratio = this.textureResolution / o.resolution; // float division: view only
    for (let v = 0; v < this.#depth; v++)
      for (let u = 0; u < this.#width; u++) {
        const fx = Math.min(o.width - 1.001, u * ratio),
          fz = Math.min(o.depth - 1.001, v * ratio),
          ix = Math.floor(fx),
          iz = Math.floor(fz),
          tx = fx - ix,
          tz = fz - iz,
          h = (i: number, j: number) => o.height[j * o.width + i],
          a = h(ix, iz) + (h(ix + 1, iz) - h(ix, iz)) * tx,
          b = h(ix, iz + 1) + (h(ix + 1, iz + 1) - h(ix, iz + 1)) * tx;
        out[v * this.#width + u] = a + (b - a) * tz;
      }
    return out;
  }

  /** Ground weights from point samples every 32 m (nearest sample), until tiles replace them. */
  #overviewWeights(): void {
    const world = this.#world,
      step = Math.max(1, Math.round(32 / this.textureResolution)), // float division: view only
      [x0, z0] = world.bounds,
      rules = rulesOf(world.biomes, this.materials),
      ids = world.biomes.map((b) => b.id),
      sums = new Int32Array(8),
      bytes = new Uint8Array(8);
    for (let v = 0; v < this.#depth; v += step)
      for (let u = 0; u < this.#width; u += step) {
        const s = world.sample(x0 + u * this.textureResolution, z0 + v * this.textureResolution);
        sums.fill(0);
        s.biomes.forEach((id, i) => {
          const layers = rules[ids.indexOf(id)];
          sums[layers[0].material] += Math.round(s.weights[i] * ONE);
        });
        quantise(sums, bytes, 0);
        for (let dv = 0; dv < step && v + dv < this.#depth; dv++)
          for (let du = 0; du < step && u + du < this.#width; du++) this.#setWeights(u + du, v + dv, bytes, 0);
      }
  }

  #setWeights(u: number, v: number, bytes: Uint8Array, at: number): void {
    const k = (v * this.#width + u) * 4;
    for (let c = 0; c < 4; c++) {
      this.#weights[0][k + c] = bytes[at + c];
      this.#weights[1][k + c] = bytes[at + 4 + c];
    }
  }

  /** Queues the tiles overlapping `rect` (nearest the camera first); resolves when they are drawn into the textures. */
  #enqueue(rect: readonly [number, number, number, number]): Promise<void> {
    this.#queue = this.#queue.then(() => this.#stream(rect)).catch(() => {});
    return this.#queue;
  }

  async #stream(rect: readonly [number, number, number, number]): Promise<void> {
    const p = this.#engine.camera.position;
    for await (const tile of this.#world.tiles(rect, { focus: [p[0], p[2]], signal: this.#signal })) {
      if (this.#disposed || this.#signal?.aborted) return;
      this.#writeTile(tile);
      // Let frames render between tiles (tiles are made on this thread until the worker pool of B7).
      await new Promise((done) => setTimeout(done, 0));
    }
  }

  #writeTile(tile: BiomeTile): void {
    const world = this.#world,
      texel = this.textureResolution,
      step = Math.round(texel / world.resolution), // float division: exact multiple
      [x0, z0] = world.bounds,
      u0 = Math.round((tile.origin[0] - x0) / texel), // float division
      v0 = Math.round((tile.origin[1] - z0) / texel), // float division
      count = Math.floor(tile.cells / step), // float division
      height = tile.layer('height')!,
      ground = groundWeights(world, tile, this.materials);
    for (let j = 0; j < count && v0 + j < this.#depth; j++)
      for (let i = 0; i < count && u0 + i < this.#width; i++) {
        const k = j * step * tile.cells + i * step;
        this.#heights[(v0 + j) * this.#width + u0 + i] = height.data[k] * height.scale;
        this.#setWeights(u0 + i, v0 + j, ground, k * 8);
      }
    this.#upload(u0, v0, Math.min(count, this.#width - u0), Math.min(count, this.#depth - v0));
  }

  /** Uploads a texel rectangle of the CPU copies (kept for device restoration). */
  #upload(u: number, v: number, w: number, d: number): void {
    const t = this.#textures;
    if (!t || w <= 0 || d <= 0) return;
    const rows = new Float32Array(w * d),
      a = new Uint8Array(w * d * 4),
      b = new Uint8Array(w * d * 4);
    for (let j = 0; j < d; j++) {
      rows.set(this.#heights.subarray((v + j) * this.#width + u, (v + j) * this.#width + u + w), j * w);
      a.set(this.#weights[0].subarray(((v + j) * this.#width + u) * 4, ((v + j) * this.#width + u + w) * 4), j * w * 4);
      b.set(this.#weights[1].subarray(((v + j) * this.#width + u) * 4, ((v + j) * this.#width + u + w) * 4), j * w * 4);
    }
    const write = (texture: GPUTexture, data: Float32Array | Uint8Array) =>
      t.device.queue.writeTexture(
        { texture, origin: [u, v] },
        data as Uint8Array<ArrayBuffer>,
        { bytesPerRow: w * 4 },
        [w, d],
      );
    write(t.height, rows);
    write(t.weights[0], a);
    write(t.weights[1], b);
    // The terrain calls `textures` while it attaches, before `this.terrain` is set.
    (this.terrain as Terrain | undefined)?.invalidate();
  }

  /** Resolves when every queued tile (the first ring and every dirty rectangle so far) is in the textures. */
  whenIdle(): Promise<void> {
    return this.#queue;
  }

  /** Stops streaming and frees the terrain and its textures. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#off();
    this.terrain.dispose();
    this.#textures = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
