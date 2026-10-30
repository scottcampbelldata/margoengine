/// <reference lib="esnext.disposable" preserve="true" />
// BiomeView (spec 4, B3, B6, B7): a biome world drawn as clipmap terrain with its stored objects. Heights and
// per-material ground weights go into `@margoengine/terrain` (its optional `TerrainTextures.weights`, decision D4): an
// overview from the region grid first, then 1 m tiles streamed around the camera and ahead of it along its velocity
// (a 300 km/h flight crosses a 256 m tile every 3.1 s), nearest first, and again for every dirty rectangle the world
// reports (so painting shows up). On a world with workers the tiles, their ground weights and their objects are made
// there; the page only sends the jobs and copies finished arrays in, a few per frame within a time budget, and tiles
// that fall behind the camera before they arrive are cancelled. Terrain is loaded with import() on attach, so this
// entry costs nothing until it is used.
// Ground layer rules use the same Wendland bands as biome envelopes (define.ts); materials are generated textures.
import type { EngineKernel } from '@margoengine/core';
import type { Terrain, TerrainColorOptions } from '@margoengine/terrain';
import type { Water, WaterOptions } from '@margoengine/water';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { type BiomeDefinition, type Dimension, fieldDimension } from './define.js';
// The toolkit comes through the package name, so the view shares the root's copy (a view always has a world).
import { clampInt, divFloor, hash3, ONE, wendland } from '@margoengine/biomes/toolkit';
import type { PlacedTile } from './placement.js';
import type { BiomeSample } from './sample.js';
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
  /** Draws the stored objects (trees, shrubs, rocks) and the detail (grass, ferns) of the world's biomes through
   * scatter. Default true. */
  readonly objects?: boolean;
  /** Detail is drawn within this distance of the camera. Default 120 m. */
  readonly detailRadius?: number;
  /** Seconds ahead along the camera's velocity that tiles are fetched early. Default 3. */
  readonly lookahead?: number;
  /** Milliseconds per frame the page may spend streaming: sending tile jobs to the world's workers and copying
   * arrived tiles in, nearest first (one always goes in). Default 0.25. */
  readonly budget?: number;
  /** Most bytes of detail density maps (`BiomeObjects` `detailBudget`); the view coarsens detail maps to fit. Default
   * 128 MiB. */
  readonly detailBudget?: number;
  /**
   * A `Shadows` from `@margoengine/shadows`: the view adds its terrain (casting and receiving) and every stored-object
   * mesh (`objects.casters`) to it, and removes them on dispose. Default none.
   */
  readonly shadows?: BiomeShadows;
  /**
   * The sea: a `@margoengine/water` surface at the world's `climate.seaLevel`, centred on the origin over the whole
   * world and out to the horizon, loaded with import() only when drawn. The terrain hides it under land, so its shore
   * follows the coast, with the water's shoreline foam. `'auto'` draws it when the world's heights reach below sea
   * level; an object draws it with those `Water` settings (pass `depth: () => bloom.depthTexture` when Bloom, SSAO or
   * DOF owns the scene depth, and `reflection`, `lights` from a `Sky`). Rivers stay dry valleys (docs/limits.md).
   * Default `'auto'`.
   */
  readonly water?: boolean | 'auto' | BiomeWaterSettings;
}

/** `Water` settings a view passes on (`@margoengine/water`); the view sets the size, the height and the horizon. */
export type BiomeWaterSettings = Omit<WaterOptions, 'size' | 'height' | 'horizon' | 'terrain' | 'spray'>;

/** What `BiomeViewOptions.shadows` needs: a `Shadows` (`@margoengine/shadows`), of which only `add` is used. */
export interface BiomeShadows {
  /** Adds a caster (and, for the terrain, a receiver); returns its remover. */
  add(source: object): () => void;
}

/** Most ground materials a view draws: the terrain's layer limit (4 weights per texture, 4 textures). */
export const MAX_GROUND_MATERIALS = 16;

/** Weight textures for `n` ground materials: 4 materials each, at least 2 (the terrain takes 2 to 4). */
const weightTextures = (n: number): number => Math.max(2, (n + 3) >> 2);

/**
 * What a view draws of one tile: heights in metres and the ground weight textures (2 to 4, 4 materials each, as many
 * as the materials need), `count` x `count` texels.
 */
export interface ViewTile {
  readonly x: number;
  readonly z: number;
  readonly count: number;
  readonly heights: Float32Array;
  readonly weights: readonly Uint8Array[];
}

/** Ground weights of the last view tile made on this thread, reused (a worker makes one tile after another). */
let ground: Uint8Array | undefined;

/** A view tile made on this thread (a world without workers): the same arrays a worker sends. */
export function viewTile(world: BiomeWorld, tile: BiomeTile, materials: readonly string[], step: number): ViewTile {
  const n = tile.cells * tile.cells * STRIDE;
  if (!ground || ground.length < n) ground = new Uint8Array(n);
  const count = Math.floor(tile.cells / step), // float division: exact multiple
    weights = weightsInto(world, tile, materials, ground),
    height = tile.layer('height')!,
    heights = new Float32Array(count * count),
    textures = Array.from({ length: weightTextures(materials.length) }, () => new Uint8Array(count * count * 4));
  for (let j = 0; j < count; j++)
    for (let i = 0; i < count; i++) {
      const k = j * step * tile.cells + i * step,
        t = j * count + i;
      heights[t] = height.data[k] * height.scale;
      for (let w = 0; w < textures.length; w++)
        textures[w].set(weights.subarray(k * STRIDE + w * 4, k * STRIDE + w * 4 + 4), t * 4);
    }
  return { x: tile.x, z: tile.z, count, heights, weights: textures };
}

/** Fields a ground layer rule can test (`GroundLayer`), each a tile layer of the same name. */
const RULE_FIELDS = ['slope', 'height', 'moisture', 'curvature', 'temperature', 'coldest', 'warmest'] as const;

/** Layers a view tile reads. */
export const VIEW_LAYERS = Object.freeze([...RULE_FIELDS, 'biome', 'biomeWeight']);

/**
 * Ground material keys of a biome list in first-use order, every one of them (a view draws up to
 * `MAX_GROUND_MATERIALS`, 16; the 8 presets use 15).
 */
export function groundMaterials(biomes: readonly BiomeDefinition[]): string[] {
  const keys: string[] = [];
  for (const b of biomes) for (const g of b.ground) if (!keys.includes(g.material)) keys.push(g.material);
  return keys;
}

/** Throws the RangeError a view gives for more ground materials than the terrain draws. */
function checkMaterialCount(materials: readonly string[]): void {
  if (materials.length > MAX_GROUND_MATERIALS)
    throw rangeError(
      `BiomeView draws up to ${MAX_GROUND_MATERIALS} ground materials and these biomes use ${materials.length}: ${materials.join(', ')}; give ground layers that look alike one material key (the \`materials\` option sets each key's look)`,
      'biomes',
    );
}

/** Per biome, per ground layer: material index, quantised rule and weight (Q16). */
type Rules = readonly (readonly { material: number; dims: readonly Dimension[]; weight: number }[])[];

function rulesOf(biomes: readonly BiomeDefinition[], materials: readonly string[]): Rules {
  checkMaterialCount(materials);
  return biomes.map((b) =>
    b.ground.map((g) => {
      const material = materials.indexOf(g.material);
      // A missing key once drew as material 0 (the default world's 9th material, boreal needles, drew as grass).
      if (material < 0)
        throw rangeError(
          `Ground material '${g.material}' of biome '${b.id}' is not in the materials list; pass groundMaterials(world.biomes)`,
          'biomes',
        );
      return {
        material,
        // Temperature rules too: tundra and alpine snow follow the cold (main read only the first four fields, so a
        // snow layer ruled by temperature alone showed everywhere).
        dims: RULE_FIELDS.filter((k) => g[k] !== undefined).map((k) => fieldDimension(k, g[k]!)),
        weight: Math.round((g.weight ?? 1) * ONE),
      };
    }),
  );
}

/** Bytes per cell of `groundWeights`: one per material, up to `MAX_GROUND_MATERIALS`. */
const STRIDE = MAX_GROUND_MATERIALS;

/**
 * Ground material weights of a tile: 16 bytes per cell (materials 0..15, `groundMaterials` order; the bytes past the
 * materials are 0) summing to 255. Each of
 * the cell's biomes shares its weight among its ground layers by their rules (Wendland bands like envelopes; a biome
 * whose rules all miss uses its first layer). Integer only.
 * @throws RangeError when a biome's ground material is not in `materials`, or for more than 16 materials.
 */
export function groundWeights(world: BiomeWorld, tile: BiomeTile, materials: readonly string[]): Uint8Array {
  return weightsInto(world, tile, materials, new Uint8Array(tile.cells * tile.cells * STRIDE));
}

/** `groundWeights` written into `out` (16 bytes per cell or more; every byte of the cells is written). */
function weightsInto(world: BiomeWorld, tile: BiomeTile, materials: readonly string[], out: Uint8Array): Uint8Array {
  const rules = rulesOf(world.biomes, materials),
    n = tile.cells * tile.cells,
    ids = tile.layer('biome')?.data,
    weights = tile.layer('biomeWeight')?.data;
  if (!ids || !weights) throw typeError('groundWeights needs a tile with the biome and biomeWeight layers', 'biomes');
  const data: Record<string, ArrayLike<number>> = {};
  for (const name of RULE_FIELDS) data[name] = tile.layer(name)?.data ?? new Int32Array(n);
  const sums = new Int32Array(STRIDE),
    share = new Int32Array(STRIDE);
  for (let k = 0; k < n; k++) {
    sums.fill(0);
    for (let s = 0; s < 4; s++) {
      const w = weights[k * 4 + s];
      if (w) addBiome(rules[ids[k * 4 + s]], data, k, w, sums, share);
    }
    quantise(sums, out, k * STRIDE);
  }
  return out;
}

/**
 * Adds one biome's ground layers at cell `k` of `data` (stored units, by layer name) to `sums`, scaled by the biome's
 * weight `w`: each layer's share is its weight times the Wendland band of every rule (a biome whose rules all miss
 * gives everything to its first layer). `share` is scratch, left zeroed.
 */
function addBiome(
  layers: Rules[number],
  data: Readonly<Record<string, ArrayLike<number>>>,
  k: number,
  w: number,
  sums: Int32Array,
  share: Int32Array,
): void {
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
  for (let i = 0; i < STRIDE; i++) {
    sums[i] += divFloor(share[i] * w, total);
    share[i] = 0;
  }
}

/** The ground weights a view starts with, before its tiles: `width` x `depth` texels in the view's weight textures. */
export interface OverviewWeights {
  readonly width: number;
  readonly depth: number;
  /** 2 to 4 textures, 4 materials each (as `ViewTile.weights`), rows of increasing z. */
  readonly weights: Uint8Array[];
}

/**
 * Ground weights of the whole world at `textureResolution` metres per texel, from the region grid
 * (`world.regionResolution`, 16 m by default) through the same ground rules as the tiles: the biomes, height, slope,
 * moisture and temperatures of every grid corner come from `world.sampleRegion` (never a cached tile, so the answer
 * does not depend on which tiles were made), and texels between corners are bilinear. A view draws these until the
 * 1 m tiles around the camera replace them, so far hills show their rock and snow.
 * @throws RangeError for a materials list that misses a biome's key or holds more than 16, or a texel size that is not
 * a positive multiple of the world resolution.
 */
export function overviewWeights(
  world: BiomeWorld,
  materials: readonly string[],
  textureResolution = 2,
): OverviewWeights {
  return overviewRows(world, materials, textureResolution, 0, Number.POSITIVE_INFINITY);
}

/**
 * Texel rows `v0` to `v1 - 1` of {@link overviewWeights} (clamped to the texture), sampling only the grid rows they
 * read: the same bytes as those rows of the whole, so workers can each make a band. `weights` hold the band's rows.
 */
export function overviewRows(
  world: BiomeWorld,
  materials: readonly string[],
  textureResolution: number,
  v0: number,
  v1: number,
): OverviewWeights & { readonly v0: number; readonly v1: number } {
  const texel = textureResolution,
    [x0, z0, x1, z1] = world.bounds,
    steps = texel / world.resolution; // float division: option check
  if (!(texel > 0) || Math.round(steps) * world.resolution !== texel)
    throw rangeError('overviewWeights textureResolution must be a positive multiple of the world resolution', 'biomes');
  const rules = rulesOf(world.biomes, materials),
    ids = world.biomes.map((b) => b.id),
    o = world.overview(),
    res = o.resolution,
    width = Math.round((x1 - x0) / texel) + 1, // float division: exact
    depth = Math.round((z1 - z0) / texel) + 1, // float division
    ratio = texel / res, // float division: view only
    row = (v: number) => Math.floor(Math.min(o.depth - 1.001, v * ratio)),
    first = Math.max(0, Math.min(depth, v0)),
    last = Math.max(first, Math.min(depth, v1)),
    // Grid rows the band reads: each texel row reads its row and the next.
    j0 = first < last ? row(first) : 0,
    j1 = first < last ? 1 + row(last - 1) : -1,
    corners = new Uint8Array(o.width * Math.max(0, j1 - j0 + 1) * STRIDE),
    data: Record<string, Int32Array> = {},
    sums = new Int32Array(STRIDE),
    share = new Int32Array(STRIDE);
  for (const name of RULE_FIELDS) data[name] = new Int32Array(1);
  let s: BiomeSample | undefined;
  for (let j = j0; j <= j1; j++)
    for (let i = 0; i < o.width; i++) {
      s = world.sampleRegion(x0 + i * res, z0 + j * res, s);
      // Stored units, as the tile layers hold them (LAYERS scales); the region has no curvature (0).
      data.height[0] = Math.round(s.height * 1000);
      data.slope[0] = Math.round(s.slope * 256);
      data.moisture[0] = Math.round(s.moisture * 255);
      data.curvature[0] = 0;
      data.temperature[0] = Math.round(s.temperature * 100);
      data.coldest[0] = Math.round(s.coldest * 100);
      data.warmest[0] = Math.round(s.warmest * 100);
      sums.fill(0);
      for (let b = 0; b < s.biomes.length; b++)
        addBiome(rules[ids.indexOf(s.biomes[b])], data, 0, Math.round(s.weights[b] * ONE), sums, share);
      quantise(sums, corners, ((j - j0) * o.width + i) * STRIDE);
    }
  const weights = Array.from(
      { length: weightTextures(materials.length) },
      () => new Uint8Array(width * (last - first) * 4),
    ),
    m = materials.length,
    cell = new Float64Array(STRIDE),
    total = o.width * o.depth,
    // Grid cells whose four corners agree (most of a world): their texels copy a corner. Indices are the band's.
    uniform = new Uint8Array(o.width * Math.max(0, j1 - j0));
  for (let q = 0; q < uniform.length; q++) {
    // A cell whose lower corners are the grid's last ones has no upper row: never uniform (as over the whole grid).
    if (q + j0 * o.width + o.width + 1 >= total) continue;
    const a = q * STRIDE,
      c = a + o.width * STRIDE;
    let same = 1;
    for (let i = 0; i < m && same; i++)
      same = +(
        corners[a + i] === corners[a + STRIDE + i] &&
        corners[a + i] === corners[c + i] &&
        corners[a + i] === corners[c + STRIDE + i]
      );
    uniform[q] = same;
  }
  for (let v = first; v < last; v++) {
    const fz = Math.min(o.depth - 1.001, v * ratio),
      iz = Math.floor(fz),
      tz = fz - iz;
    for (let u = 0; u < width; u++) {
      const fx = Math.min(o.width - 1.001, u * ratio),
        ix = Math.floor(fx),
        tx = fx - ix,
        a = ((iz - j0) * o.width + ix) * STRIDE,
        b = a + STRIDE,
        c = a + o.width * STRIDE,
        d = c + STRIDE,
        t = ((v - first) * width + u) * 4;
      if (uniform[(iz - j0) * o.width + ix]) {
        for (let i = 0; i < m; i++) weights[i >> 2][t + (i & 3)] = corners[a + i];
        continue;
      }
      // Bilinear, rounded, with the rounding remainder on the largest weight so the texel still sums to 255.
      let given = 0,
        best = 0;
      for (let i = 0; i < m; i++) {
        const top = corners[a + i] + (corners[b + i] - corners[a + i]) * tx,
          bottom = corners[c + i] + (corners[d + i] - corners[c + i]) * tx;
        cell[i] = Math.round(top + (bottom - top) * tz);
        given += cell[i];
        if (cell[i] > cell[best]) best = i;
      }
      cell[best] += 255 - given;
      for (let i = 0; i < m; i++) weights[i >> 2][t + (i & 3)] = cell[i];
    }
  }
  return { width, depth, weights, v0: first, v1: last };
}

/** Writes 16 weights proportional to `w` summing to 255 (largest remainder, ties by index). */
function quantise(w: Int32Array, out: Uint8Array, at: number): void {
  let total = 0;
  for (let i = 0; i < STRIDE; i++) total += w[i];
  if (!total) {
    // All to the first material, the other fifteen 0 (the array may be reused).
    out.fill(0, at + 1, at + STRIDE)[at] = 255;
    return;
  }
  let given = 0;
  for (let i = 0; i < STRIDE; i++) {
    out[at + i] = divFloor(w[i] * 255, total);
    given += out[at + i];
  }
  for (let left = 255 - given; left > 0; left--) {
    let best = 0,
      rem = -1;
    for (let i = 0; i < STRIDE; i++) {
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
/** Texels of a view tile copied in per step (rows of it): 16 kB per texture, tens of microseconds. */
const BAND = 4096;
/** Views attached so far (each registers a uniquely named per-frame plugin). */
let views = 0;

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
  /** CPU copies of the weight textures, 4 bytes per texel each. */
  readonly #weights: Uint8Array[];
  readonly #radius: number;
  readonly #signal?: AbortSignal;
  readonly #lookahead: number;
  readonly #budget: number;
  /** Distance within which small plants, rocks and props are drawn (BiomeObjects' near radius). */
  readonly #near: number;
  #textures?: { device: GPUDevice; height: GPUTexture; weights: GPUTexture[] };
  #off: () => void;
  #offObjects?: () => void;
  /** Removers of the casters added to `options.shadows`. */
  #offShadows: (() => void)[] = [];
  /** Streaming: tiles drawn at full detail, tiles whose objects are on the GPU, jobs on their way (`v` view, `p`
   * objects, then `x,z`) with their tile, the frame's streaming work (finished jobs waiting to be copied in, jobs
   * waiting to be sent), the camera's last place and velocity. */
  readonly #drawn = new Set<string>();
  /** Tiles whose objects are on the GPU: the tile, and whether it went in near the camera (with the small plants). */
  readonly #placed = new Map<string, readonly [number, number, boolean]>();
  readonly #pending = new Map<
    string,
    { readonly controller: AbortController; readonly x: number; readonly z: number }
  >();
  readonly #arrived: { priority: number; apply: () => void; key: string; last: boolean; send?: boolean }[] = [];
  /** True while a frame plans: jobs it starts are sent within the frame budget, not all at once. */
  #inFrame = false;
  /** What a send that reached a worker took lately (the largest, fading by a fifth a send). */
  #sendCost = 0;
  /** Copying time spent so far on tiles whose steps are not all in, by job key. */
  readonly #work = new Map<string, number>();
  #eye?: [number, number];
  readonly #velocity: [number, number] = [0, 0];
  #planned?: [number, number];
  #lastFrame = 0;
  /** The last frame planned and left its sending and copying to this one. */
  #waited = false;
  /** Frames since the last plan (a camera that stays put plans again after 30), and plans made so far. */
  #since = 0;
  #plans = 0;
  #first?: Set<string>;
  #firstDone?: () => void;
  #idle: (() => void)[] = [];
  #drainTimer?: ReturnType<typeof setTimeout>;
  /**
   * Page-thread time each arrived tile took to copy in, milliseconds (the last 600 tiles, terrain and objects apart),
   * and the streaming time (copying tiles in, sending jobs) of each frame that did any: for budgets and tests.
   */
  readonly tileTimes: number[] = [];
  readonly frameTimes: number[] = [];
  #objects?: import('@margoengine/biomes/objects').BiomeObjects;
  #water?: Water;
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
    this.#lookahead = options.lookahead ?? 3;
    this.#budget = options.budget ?? 0.25;
    this.#near = Math.min(this.#radius, 300);
    if (!(this.#lookahead >= 0) || !(this.#budget > 0))
      throw rangeError('BiomeView lookahead must be 0 or more seconds and budget above 0 ms', 'biomes');
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
    checkMaterialCount(this.materials);
    const looks = this.materials.map((key) => look(key, options.materials)),
      // The terrain needs 4 to 16 layers: repeat the last material when there are fewer.
      layerKeys = [...this.materials];
    while (layerKeys.length < 4) layerKeys.push(layerKeys[layerKeys.length - 1]);
    const pixels = layerKeys.map((key, i) => materialPixels(key, looks[Math.min(i, looks.length - 1)]));
    this.#heights = this.#overviewHeights();
    // The far-field ground weights arrive in `#overview` (on the workers when the world has them), before any tile.
    this.#weights = Array.from(
      { length: weightTextures(this.materials.length) },
      () => new Uint8Array(this.#width * this.#depth * 4),
    );
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
          weights = view.#weights.map(() => device.createTexture({ size, format: 'rgba8unorm', usage })),
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
    this.#off = world.onChange((rect) => this.#dirty(rect, 'v'));
    this.ready = new Promise((done) => {
      this.#firstDone = done;
    });
  }

  /**
   * Draws a biome world as terrain on a WebGPU engine. Loads `@margoengine/terrain` on first use.
   * @throws MargoError `'unsupported'` on a WebGL engine; RangeError for bad options and for biomes with more than 16
   * ground materials (`groundMaterials`). Rejects with the signal's reason.
   */
  static async attach(engine: EngineKernel, world: BiomeWorld, options: BiomeViewOptions = {}): Promise<BiomeView> {
    if (!engine || !world || typeof world.tile !== 'function')
      throw typeError('BiomeView.attach takes an engine and a BiomeWorld', 'biomes');
    checkMaterialCount(groundMaterials(world.biomes));
    if (engine.backend !== 'webgpu')
      throw fault('unsupported', 'BiomeView needs a WebGPU engine; create the engine with WebGPU', 'biomes');
    const shadows = options.shadows;
    if (shadows !== undefined && typeof shadows?.add !== 'function')
      throw typeError('BiomeView shadows must be a Shadows from @margoengine/shadows', 'biomes');
    const water = options.water ?? 'auto';
    if (water !== true && water !== false && water !== 'auto' && (typeof water !== 'object' || water === null))
      throw typeError("BiomeView water must be true, false, 'auto' or Water settings", 'biomes');
    if (options.signal?.aborted) throw options.signal.reason;
    const terrainModule = await import('@margoengine/terrain');
    if (options.signal?.aborted) throw options.signal.reason;
    const limit = (engine as unknown as { gpu?: GPUDevice }).gpu?.limits.maxTextureDimension2D ?? 8192;
    const view = new BiomeView(engine, world, options, terrainModule, limit),
      // The overview runs while the objects load: on the workers off this thread, or here when there are none.
      overview = view.#overview(options.signal);
    // A failed attach must not leave the overview's rejection unhandled; it is awaited below.
    overview.catch(() => {});
    if (options.objects ?? true) {
      // Placement and its drawing are their own entries, loaded only for a view that draws objects.
      const [{ BiomePlacement }, { BiomeObjects, detailFits }] = await Promise.all([
          import('@margoengine/biomes/placement'),
          import('@margoengine/biomes/objects'),
        ]),
        t = view.textureResolution / 2,
        [x0, z0, x1, z1] = world.bounds;
      const placement = BiomePlacement.attach(world),
        bounds = [x0 - t, z0 - t, x1 + t, z1 + t] as const;
      view.#placement = placement;
      // Detail maps start at the terrain's texel and coarsen by halves until they fit the budget and the device.
      let detail = view.textureResolution;
      while (!detailFits(bounds, detail, placement.details.length, limit, options.detailBudget)) detail *= 2;
      view.#detailStep = Math.round(detail / world.resolution); // float division: exact multiple
      view.#objects = await BiomeObjects.attach(engine, placement, {
        heightmap: () => view.#textures?.height,
        // Height texels sit on the world's grid corners: the rectangle their centres cover is half a texel wider.
        bounds,
        radius: options.radius ?? 1000,
        detailRadius: options.detailRadius ?? 120,
        detailResolution: detail,
        detailBudget: options.detailBudget,
      });
      view.#offObjects = placement.onChange((rect) => view.#dirty(rect, 'p'));
    }
    try {
      await overview;
    } catch (error) {
      view.dispose();
      throw error;
    }
    if (shadows)
      for (const source of [view.terrain, ...(view.#objects?.casters ?? [])])
        view.#offShadows.push(shadows.add(source));
    const sea = world.climate.sea / 1000; // float division: mm to metres
    if (water === true || typeof water === 'object' || (water === 'auto' && view.#heights.some((h) => h < sea))) {
      const { Water } = await import('@margoengine/water'),
        [x0, z0, x1, z1] = world.bounds,
        side = (a: number, b: number) => Math.min(100000, 2 * Math.max(Math.abs(a), Math.abs(b)));
      // The water grid is centred on the origin: wide enough to cover the world, stretched to the horizon past it.
      if (!view.#disposed)
        view.#water = Water.attach(engine, {
          ...(typeof water === 'object' ? water : {}),
          size: [side(x0, x1), side(z0, z1)],
          height: sea,
          horizon: true,
        });
    }
    if (options.signal?.aborted) {
      view.dispose();
      throw options.signal.reason;
    }
    // Streaming runs before every frame; `ready` resolves once the tiles around the camera are in.
    engine.use({ name: `biomes-view:${++views}`, setup() {}, onPreUpdate: (delta) => view.#frame(delta) });
    view.#name = `biomes-view:${views}`;
    view.#plan(true);
    return view;
  }

  /**
   * Fills the far-field ground weights (`overviewWeights`) and uploads them. With workers the texel rows go out in one
   * band per worker (`overviewRows`, the same bytes as the whole), so the page's thread only copies the bands in.
   */
  async #overview(signal?: AbortSignal): Promise<void> {
    const world = this.#world,
      workers = world.workers,
      texel = this.textureResolution,
      width = this.#width,
      depth = this.#depth;
    if (!workers)
      overviewWeights(world, this.materials, texel).weights.forEach((data, i) => this.#weights[i].set(data));
    else {
      const n = workers.size,
        bands = await Promise.all(
          Array.from({ length: n }, (_, b) =>
            workers.run<OverviewWeights & { v0: number; v1: number }>(
              {
                op: 'overview',
                materials: [...this.materials],
                texel,
                v0: divFloor(b * depth, n),
                v1: divFloor((b + 1) * depth, n),
              },
              { signal },
            ),
          ),
        );
      if (this.#disposed) return;
      for (const band of bands) band.weights.forEach((data, i) => this.#weights[i].set(data, band.v0 * width * 4));
    }
    const t = this.#textures;
    if (!t || this.#disposed) return;
    for (let i = 0; i < t.weights.length; i++)
      t.device.queue.writeTexture(
        { texture: t.weights[i] },
        this.#weights[i] as Uint8Array<ArrayBuffer>,
        { bytesPerRow: width * 4 },
        [width, depth],
      );
  }

  #placement?: import('@margoengine/biomes/placement').BiomePlacement;
  /** World cells per detail texel (the worker samples detail maps at it). */
  #detailStep = 1;
  #name = '';

  /**
   * Before each frame: track the camera, plan when it moved, copy arrived tiles in within the budget. A frame that
   * plans leaves sending and copying to the next frame (a plan comes every few frames and takes a good part of the
   * budget; sending its jobs in the same frame made those frames the slowest 1 percent on a laptop APU), unless the
   * frame before planned too (a camera that plans every frame still gets its tiles). The plan of a camera that stays
   * put comes 30 frames after the last plan, not every 30th frame: that one could come the frame after a plan of the
   * moving camera, and the second plan then streamed too.
   */
  #frame(delta: number): void {
    if (this.#disposed) return;
    this.#lastFrame = performance.now();
    const p = this.#engine.camera.position,
      eye: [number, number] = [p[0], p[2]];
    if (this.#eye && delta > 0) {
      // Velocity, smoothed over about five frames.
      for (let i = 0; i < 2; i++) this.#velocity[i] += ((eye[i] - this.#eye[i]) / delta - this.#velocity[i]) * 0.2; // float division: view only
    }
    this.#eye = eye;
    const moved = this.#planned ? Math.hypot(eye[0] - this.#planned[0], eye[1] - this.#planned[1]) : Infinity,
      plan = moved > this.#world.tileSize / 8 || ++this.#since >= 30;
    if (plan) {
      this.#inFrame = true;
      this.#plan(false);
      this.#inFrame = false;
    }
    if ((this.#waited = plan && !this.#waited)) return;
    this.#apply(this.#budget);
  }

  /**
   * The tiles to have: within the radius of the camera or of where it will be `lookahead` seconds on. Missing ones
   * are fetched nearest first; ones on their way that fell out of range are cancelled; objects of tiles left behind
   * leave the GPU.
   */
  #plan(first: boolean): void {
    if (this.#disposed) return;
    const p = this.#engine.camera.position,
      eye: [number, number] = [p[0], p[2]],
      ahead: [number, number] = [
        eye[0] + this.#velocity[0] * this.#lookahead,
        eye[1] + this.#velocity[1] * this.#lookahead,
      ],
      w = this.#world,
      side = w.tileSize,
      r = this.#radius,
      [bx, bz] = w.bounds,
      near = (x: number, z: number, at: readonly [number, number]) =>
        Math.hypot(
          Math.max(0, bx + x * side - at[0], at[0] - bx - (x + 1) * side),
          Math.max(0, bz + z * side - at[1], at[1] - bz - (z + 1) * side),
        ),
      tx = (v: number) => Math.min(w.tilesX - 1, Math.max(0, Math.floor((v - bx) / side))), // float division: view only
      tz = (v: number) => Math.min(w.tilesZ - 1, Math.max(0, Math.floor((v - bz) / side))), // float division: view only
      wanted: [number, number, number][] = [];
    this.#planned = eye;
    this.#since = 0;
    this.#plans++;
    for (let z = tz(Math.min(eye[1], ahead[1]) - r); z <= tz(Math.max(eye[1], ahead[1]) + r); z++)
      for (let x = tx(Math.min(eye[0], ahead[0]) - r); x <= tx(Math.max(eye[0], ahead[0]) + r); x++) {
        const d = near(x, z, eye);
        if (Math.min(d, near(x, z, ahead)) <= r) wanted.push([d, x, z]);
      }
    wanted.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
    if (first) this.#first = new Set();
    for (const [d, x, z] of wanted) {
      const key = `${x},${z}`;
      if (!this.#drawn.has(key) && !this.#pending.has('v' + key)) this.#fetch('v', x, z, d);
      if (this.#objects && !this.#placed.has(key) && !this.#pending.has('p' + key)) this.#fetch('p', x, z, d);
      if (first && d <= r) {
        this.#first!.add('v' + key);
        if (this.#objects) this.#first!.add('p' + key);
      }
    }
    // Cancel what fell out of range on its way; take objects of tiles behind the camera off the GPU.
    for (const [key, job] of this.#pending)
      if (Math.min(near(job.x, job.z, eye), near(job.x, job.z, ahead)) > r + side) this.#cancel(key);
    for (const [key, [x, z, close]] of this.#placed) {
      const d = near(x, z, eye);
      if (d > r + side) {
        this.#objects!.remove(key);
        this.#placed.delete(key);
      } else if (close !== d <= this.#near && (close ? d > this.#near + side : true) && !this.#pending.has('p' + key))
        // Small plants, rocks and props go in within the near radius and out a tile beyond it: place it again.
        this.#fetch('p', x, z, d);
    }
    this.#settled();
  }

  /** A tile's terrain (`v`) or objects (`p`), made by the world's workers when it has them. */
  #make(kind: 'v' | 'p', x: number, z: number, priority: number, signal?: AbortSignal): Promise<ViewTile | PlacedTile> {
    const w = this.#world,
      step = Math.round(this.textureResolution / w.resolution); // float division: exact multiple
    if (kind === 'p') return this.#placement!.tile(x, z, { signal, priority, detail: this.#detailStep });
    return w.workers
      ? w.workers.run<ViewTile>(
          { op: 'view', x, z, materials: this.materials, step },
          { near: [x, z], priority, signal },
        )
      : // No workers: made on this thread, one per task so frames keep drawing.
        new Promise<void>((done) => setTimeout(done, 0))
          .then(() => w.tile(x, z, { layers: VIEW_LAYERS, signal }))
          .then((tile) => viewTile(w, tile, this.materials, step));
  }

  /**
   * Starts one job: `v` the tile's terrain, `p` its objects; the result waits in `#arrived` to be copied in. A job a
   * frame starts is sent within the frame budget, nearest first, along with the copying: a send to an idle worker
   * wakes its thread (about 40 microseconds on a desktop, several times that on a laptop), and one plan may start a
   * dozen jobs.
   */
  #fetch(kind: 'v' | 'p', x: number, z: number, priority: number): void {
    const key = kind + `${x},${z}`,
      job = { controller: new AbortController(), x, z },
      made = this.#made.get(key);
    this.#pending.set(key, job);
    // A prefetched tile is ready already (nothing to send); it still goes in through the frame budget.
    if (made || !this.#inFrame) this.#start(kind, key, job, priority, made);
    else {
      this.#arrived.push({
        priority,
        key,
        last: false,
        send: true,
        apply: () => this.#pending.get(key) === job && this.#start(kind, key, job, priority),
      });
      this.#drainTimer ??= setTimeout(this.#drain, 50);
    }
  }

  /** Drops a job on its way (one not sent yet is skipped when its turn comes). */
  #cancel(key: string): void {
    this.#pending.get(key)?.controller.abort();
    this.#pending.delete(key);
    this.#first?.delete(key);
  }

  #start(
    kind: 'v' | 'p',
    key: string,
    job: { readonly controller: AbortController; readonly x: number; readonly z: number },
    priority: number,
    made?: ViewTile | PlacedTile,
  ): void {
    const { controller, x, z } = job,
      signal = this.#signal ? AbortSignal.any([this.#signal, controller.signal]) : controller.signal;
    (made ? Promise.resolve(made) : this.#make(kind, x, z, priority, signal)).then(
      (result) => {
        if (this.#pending.get(key) !== job || this.#disposed) return;
        this.#pending.delete(key);
        if (kind === 'p') {
          // Objects go in a species at a time (each step is small), so one tile never takes a whole frame.
          const steps = this.#objects!.steps(result as PlacedTile, priority),
            last = steps.pop()!;
          for (const apply of steps) this.#arrived.push({ priority, apply, key, last: false });
          this.#arrived.push({
            priority,
            key,
            last: true,
            apply: () => {
              last();
              this.#placed.set(`${x},${z}`, [x, z, priority <= this.#near]);
              this.#first?.delete(key);
            },
          });
        } else {
          // Terrain goes in a band of rows at a time (BAND texels: three small texture writes), so one tile never
          // takes a frame on a slow machine either; the tile counts as drawn once its last band is in.
          const tile = result as ViewTile,
            rows = Math.max(1, (BAND / tile.count) | 0); // float division: whole rows
          for (let j = 0; j < tile.count; j += rows) {
            const end = Math.min(tile.count, j + rows),
              last = end === tile.count;
            this.#arrived.push({
              priority,
              key,
              last,
              apply: () => {
                this.#writeView(tile, j, end);
                if (last) {
                  this.#drawn.add(`${x},${z}`);
                  this.#first?.delete(key);
                }
              },
            });
          }
        }
        // Without frames (a page that waits for `ready` before drawing) the results go in from a timer.
        this.#drainTimer ??= setTimeout(this.#drain, 50);
      },
      () => {
        if (this.#pending.get(key) === job) this.#pending.delete(key);
        this.#first?.delete(key);
        this.#settled();
      },
    );
  }

  /** Copies everything in when no frame has drawn for 100 ms; frames copy within their budget otherwise. */
  #drain = (): void => {
    this.#drainTimer = undefined;
    if (!this.#arrived.length || this.#disposed) return;
    if (performance.now() - this.#lastFrame > 100) this.#apply(Infinity);
    else this.#drainTimer = setTimeout(this.#drain, 100);
  };

  /** Finished tiles made ahead by `prefetch`, by job key (at most 1,024). */
  readonly #made = new Map<string, ViewTile | PlacedTile>();

  /**
   * Makes the tiles of a world rectangle (metres) ahead of time, terrain and objects, so a camera that goes there
   * later finds them ready (a planned flight, a loading screen). They go in when the camera comes within range.
   * Rejects with the signal's reason when aborted.
   */
  async prefetch(
    rect: readonly [number, number, number, number],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite))
      throw typeError('BiomeView prefetch takes a [minX, minZ, maxX, maxZ] rectangle in metres', 'biomes');
    const w = this.#world,
      side = w.tileSize,
      jobs: Promise<void>[] = [];
    for (let z = 0; z < w.tilesZ; z++)
      for (let x = 0; x < w.tilesX; x++) {
        const x0 = w.bounds[0] + x * side,
          z0 = w.bounds[1] + z * side;
        if (x0 >= rect[2] || x0 + side <= rect[0] || z0 >= rect[3] || z0 + side <= rect[1]) continue;
        for (const kind of this.#objects ? (['v', 'p'] as const) : (['v'] as const)) {
          const key = kind + `${x},${z}`;
          if (this.#made.has(key) || this.#made.size >= 1024) continue;
          jobs.push(
            this.#make(kind, x, z, 0, options.signal).then((result) => {
              this.#made.set(key, result);
            }),
          );
        }
      }
    await Promise.all(jobs);
  }

  /**
   * Sends waiting jobs and copies arrived tiles in, nearest first (one step always goes in). Copying goes on while
   * budget is left: its steps are small, and holding them back for the dearest copy step seen lately left tiles
   * copying over four times as many frames. A send starts only when the budget left covers what a send that reached a
   * worker took lately: waking a worker thread costs many copy steps on a laptop.
   */
  #apply(budget: number): void {
    const start = performance.now(),
      workers = this.#world.workers;
    let n = 0;
    while (this.#arrived.length) {
      let best = 0;
      for (let i = 1; i < this.#arrived.length; i++)
        if (this.#arrived[i].priority < this.#arrived[best].priority) best = i;
      if (n && performance.now() - start + (this.#arrived[best].send ? this.#sendCost : 0) >= budget) break;
      const [next] = this.#arrived.splice(best, 1),
        posts = workers?.posts,
        t0 = performance.now();
      next.apply();
      n++;
      if (next.send) {
        // Only a send that reached a worker counts: one queued behind busy workers (or cancelled) costs nothing, and
        // counting those let the estimate fade until a send that woke a worker started late in a frame.
        if (workers?.posts !== posts) this.#sendCost = Math.max(performance.now() - t0, this.#sendCost * 0.8);
        continue;
      }
      const spent = (this.#work.get(next.key) ?? 0) + performance.now() - t0;
      if (next.last) {
        this.#work.delete(next.key);
        this.tileTimes.push(spent);
        if (this.tileTimes.length > 600) this.tileTimes.shift();
      } else this.#work.set(next.key, spent);
    }
    if (n && Number.isFinite(budget)) {
      this.frameTimes.push(performance.now() - start);
      if (this.frameTimes.length > 600) this.frameTimes.shift();
    }
    this.#settled();
  }

  /** Resolves `ready` once the first tiles are in, and `whenIdle` waiters once nothing is on its way. */
  #settled(): void {
    if (this.#first && !this.#first.size) {
      this.#first = undefined;
      this.#firstDone?.();
    }
    if (!this.#pending.size && !this.#arrived.length && this.#idle.length)
      for (const done of this.#idle.splice(0)) done();
  }

  /**
   * A dirty world rectangle: its tiles (terrain `v` or objects `p`) are made again when in range (the old ones drawn
   * until the new ones are in); jobs on their way and prefetched tiles there are dropped.
   */
  #dirty(rect: readonly [number, number, number, number], kind: 'v' | 'p'): void {
    const w = this.#world,
      side = w.tileSize,
      held = kind === 'v' ? [...this.#drawn] : [...this.#placed.keys()],
      keys = [...this.#pending.keys(), ...this.#made.keys()].filter((k) => k[0] === kind).map((k) => k.slice(1));
    for (const key of new Set([...held, ...keys])) {
      const [x, z] = key.split(',').map(Number),
        x0 = w.bounds[0] + x * side,
        z0 = w.bounds[1] + z * side;
      if (x0 < rect[2] && x0 + side > rect[0] && z0 < rect[3] && z0 + side > rect[1]) {
        this.#made.delete(kind + key);
        this.#cancel(kind + key);
        // Terrain is made again by the next plan; objects are placed again now (they stay until the new ones are in).
        if (kind === 'v') this.#drawn.delete(key);
        else if (this.#placed.has(key)) {
          const e = this.#engine.camera.position;
          this.#fetch(
            'p',
            x,
            z,
            Math.hypot(Math.max(0, x0 - e[0], e[0] - x0 - side), Math.max(0, z0 - e[2], e[2] - z0 - side)),
          );
        }
      }
    }
    this.#plan(false);
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

  /**
   * Copies rows `j0` to `j1` of a view tile into the CPU copies of the textures and uploads them straight from the
   * tile's arrays. The terrain is told once the tile's last row is in.
   */
  #writeView(tile: ViewTile, j0: number, j1: number): void {
    const w = this.#world,
      texel = this.textureResolution,
      [x0, z0] = w.bounds,
      u0 = Math.round((x0 + tile.x * w.tileSize - x0) / texel), // float division: whole texels
      v0 = Math.round((z0 + tile.z * w.tileSize - z0) / texel), // float division
      cw = Math.min(tile.count, this.#width - u0),
      cd = Math.min(tile.count, this.#depth - v0),
      end = Math.min(j1, cd);
    for (let j = j0; j < end; j++) {
      const row = (v0 + j) * this.#width + u0;
      this.#heights.set(tile.heights.subarray(j * tile.count, j * tile.count + cw), row);
      for (let w = 0; w < this.#weights.length; w++)
        this.#weights[w].set(tile.weights[w].subarray(j * tile.count * 4, (j * tile.count + cw) * 4), row * 4);
    }
    const t = this.#textures;
    if (!t || cw <= 0 || end <= j0) return;
    if (cw === tile.count) {
      // The tile's own arrays are the texel rectangle: no staging copy (4 bytes per texel in all of them).
      const write = (texture: GPUTexture, data: Float32Array | Uint8Array) =>
        t.device.queue.writeTexture(
          { texture, origin: [u0, v0 + j0] },
          data as Uint8Array<ArrayBuffer>,
          { offset: j0 * tile.count * 4, bytesPerRow: tile.count * 4 },
          [cw, end - j0],
        );
      write(t.height, tile.heights);
      t.weights.forEach((texture, w) => write(texture, tile.weights[w]));
      if (end === cd) (this.terrain as Terrain | undefined)?.invalidate();
    } else this.#upload(u0, v0 + j0, cw, end - j0);
  }

  /** Uploads a texel rectangle of the CPU copies (kept for device restoration). */
  #upload(u: number, v: number, w: number, d: number): void {
    const t = this.#textures;
    if (!t || w <= 0 || d <= 0) return;
    const rows = new Float32Array(w * d),
      packed = this.#weights.map(() => new Uint8Array(w * d * 4));
    for (let j = 0; j < d; j++) {
      rows.set(this.#heights.subarray((v + j) * this.#width + u, (v + j) * this.#width + u + w), j * w);
      packed.forEach((out, i) =>
        out.set(
          this.#weights[i].subarray(((v + j) * this.#width + u) * 4, ((v + j) * this.#width + u + w) * 4),
          j * w * 4,
        ),
      );
    }
    const write = (texture: GPUTexture, data: Float32Array | Uint8Array) =>
      t.device.queue.writeTexture(
        { texture, origin: [u, v] },
        data as Uint8Array<ArrayBuffer>,
        { bytesPerRow: w * 4 },
        [w, d],
      );
    write(t.height, rows);
    t.weights.forEach((texture, i) => write(texture, packed[i]));
    // The terrain calls `textures` while it attaches, before `this.terrain` is set.
    (this.terrain as Terrain | undefined)?.invalidate();
  }

  /** The sea surface the view draws (option `water`), or undefined without one. */
  get water(): Water | undefined {
    return this.#water;
  }

  /** The stored objects and detail the view draws (`count`, `gpuBytes`, `dropped`), or undefined with `objects: false`. */
  get objects(): import('@margoengine/biomes/objects').BiomeObjects | undefined {
    return this.#objects;
  }

  /** Resolves when no tile is on its way or waiting to be copied in (the tiles around the camera and every dirty one). */
  whenIdle(): Promise<void> {
    if (this.#disposed || (!this.#pending.size && !this.#arrived.length)) return Promise.resolve();
    return new Promise((done) => this.#idle.push(done));
  }

  /** Tiles on their way (terrain and objects jobs), tiles waiting to be copied in, and plans made so far (a plan picks
   * the tiles to have when the camera moved an eighth of a tile or after 30 frames). */
  get streaming(): { readonly pending: number; readonly arrived: number; readonly plans: number } {
    return { pending: this.#pending.size, arrived: this.#arrived.length, plans: this.#plans };
  }

  /** Stops streaming and frees the terrain and its textures. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#off();
    this.#offObjects?.();
    for (const off of this.#offShadows.splice(0)) off();
    for (const job of this.#pending.values()) job.controller.abort();
    this.#pending.clear();
    this.#arrived.length = 0;
    clearTimeout(this.#drainTimer);
    if (this.#name) this.#engine.removePlugin(this.#name);
    this.terrain.dispose();
    this.#objects?.dispose();
    this.#water?.dispose();
    this.#placement?.dispose();
    this.#textures = undefined;
    this.#firstDone?.();
    for (const done of this.#idle.splice(0)) done();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
