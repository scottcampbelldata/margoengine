// @margoengine/voxel/generate: world generation in workers (design: packages/voxel/DESIGN.md, `./generate`). An app's
// own module worker calls serveVoxelGenerator; the built-in noiseTerrain runs in dist/workers/terrain.js.
import { fbm, Noise } from '@margoengine/procedural/noise';
import { serve } from '../../shared/worker.js';
import type { BlockType } from './blocks.js';
import { VoxelChunk } from './chunk.js';

/** What a {@link VoxelGenerate} function gets besides the chunk. */
export interface VoxelGenerateContext {
  /** The world's block types by id (its `BlockTypes.table`): find a type by `name` for its id. */
  readonly blocks: readonly BlockType[];
}

/**
 * Fills `chunk`, a new air chunk, with the blocks of chunk (cx, cy, cz): local cell (x, y, z) is world cell
 * (32 cx + x, 32 cy + y, 32 cz + z). It must give the same blocks for the same chunk every time and in any order, so
 * anything that crosses chunk borders (a tree) has to follow from the coordinates alone. Light can stay 0:
 * `@margoengine/voxel/light` recomputes it.
 */
export type VoxelGenerate = (
  chunk: VoxelChunk,
  cx: number,
  cy: number,
  cz: number,
  context: VoxelGenerateContext,
) => void | Promise<void>;

/**
 * Serves `generate` from the module worker that calls it. A {@link VoxelStreamer} whose `generator` is this worker's
 * URL posts one job per chunk that is not in its store: `generate` fills a new air chunk, which goes back packed (its
 * arrays move without copies). A throw or rejection fails that chunk: the streamer reports it through `onError`.
 *
 * ```ts
 * // islands.worker.js; with Vite: import islands from './islands.worker.js?worker&url'
 * import { serveVoxelGenerator } from '@margoengine/voxel/generate';
 * serveVoxelGenerator((chunk, cx, cy, cz, { blocks }) => {
 *   if (cy < 0) chunk.fill(blocks.find((type) => type.name === 'stone').id);
 * });
 * ```
 * @throws TypeError when `generate` is not a function.
 */
export function serveVoxelGenerator(generate: VoxelGenerate): void {
  if (typeof generate !== 'function')
    throw new TypeError('serveVoxelGenerator expects a function (chunk, cx, cy, cz, context)');
  serve(async ({ cx, cy, cz, blocks }: { cx: number; cy: number; cz: number; blocks: BlockType[] }) => {
    const chunk = new VoxelChunk();
    await generate(chunk, cx, cy, cz, { blocks });
    return chunk.pack();
  });
}

/** Options of {@link noiseTerrain}: plain data (VoxelStreamer posts them to its terrain workers). */
export interface NoiseTerrainOptions {
  /** Seed of the ground, caves and trees, an integer in -2^31..2^31-1: same seed and options, same world. Default 1. */
  seed?: number;
  /** Cell y the sea fills up to: open cells at or below it over low ground are water. Default 0. */
  seaLevel?: number;
  /** Mean ground height, in cells. Default 8. */
  height?: number;
  /** How far the ground rises above and sinks below `height`, in blocks (>= 0). Default 32. */
  amplitude?: number;
  /** Width of the largest hills, in blocks (> 0). Default 192. */
  scale?: number;
  /** How much rock is tunnelled into caves, 0 (none) to 1; rock beside water is never tunnelled. Default 0.3. */
  caves?: number;
  /** Chance that a grass column grows a tree where its crown has open air, 0 to 1. Default 0.01. */
  trees?: number;
  /**
   * Names of the block types to build with, looked up in the world's types; each defaults to its key. `log` and
   * `leaves` are needed only when `trees` > 0.
   */
  blocks?: {
    stone?: string;
    dirt?: string;
    grass?: string;
    sand?: string;
    water?: string;
    log?: string;
    leaves?: string;
  };
}

const NAMES = ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves'] as const;
const R = 2, // tree crown radius: trees standing up to R columns outside a chunk reach into it
  M = 2 * R, // heights kept around the chunk: those trees' crowns cover columns up to 2R outside it
  W = 32 + 2 * M;

const option = (value: unknown, name: string, fallback: number, ok: (v: number) => boolean, range: string): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number') throw new TypeError(`NoiseTerrainOptions.${name} must be a number`);
  if (!ok(value)) throw new RangeError(`NoiseTerrainOptions.${name} is ${value}; pass ${range}`);
  return value;
};
const finite = (v: number): boolean => Number.isFinite(v);
// An unsigned 32-bit hash of a column: the per-column rule that places trees the same in every chunk.
const hash = (x: number, z: number, seed: number): number => {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};
const lerp = (p: number, q: number, t: number): number => p + (q - p) * t;
// Trilinear blend at local cell (x, y, z) of a 9^3 grid sampled every 4 cells (index i + 9 j + 81 k).
const blend = (f: Float64Array, x: number, y: number, z: number): number => {
  const s = (x >> 2) + 9 * (y >> 2) + 81 * (z >> 2),
    u = (x & 3) / 4,
    v = (y & 3) / 4;
  return lerp(
    lerp(lerp(f[s], f[s + 1], u), lerp(f[s + 9], f[s + 10], u), v),
    lerp(lerp(f[s + 81], f[s + 82], u), lerp(f[s + 90], f[s + 91], u), v),
    (z & 3) / 4,
  );
};

/**
 * The built-in world generator: a fractal (fbm) simplex heightmap of grass over dirt over stone, sand beaches and sea
 * floors, water up to `seaLevel`, cave tunnels where two 3D simplex fields are both near zero (sampled every 4 blocks
 * and blended, never through the top block, and never beside water: rock next to the sea stays), and trees on grass:
 * a column grows one when its hash says so and its whole crown is in the open air above the ground (no leaves in
 * hillsides or caves), so a crown that crosses a chunk border is the same in every chunk. Block types come by name
 * ({@link NoiseTerrainOptions.blocks}), so it works with any `BlockTypes`. Runs on any thread; VoxelStreamer runs it in
 * workers.
 * @throws TypeError for an option of the wrong type; the returned function throws TypeError for a context without
 * `blocks`.
 * @throws RangeError for an option out of range; the returned function throws RangeError for a block name the context
 * does not define.
 */
export function noiseTerrain(options: NoiseTerrainOptions = {}): VoxelGenerate {
  if (!options || typeof options !== 'object') throw new TypeError('noiseTerrain options must be an object');
  const seed = option(options.seed, 'seed', 1, (v) => (v | 0) === v, 'an integer in -2^31..2^31-1'),
    seaLevel = option(options.seaLevel, 'seaLevel', 0, (v) => (v | 0) === v, 'an integer cell y'),
    height = option(options.height, 'height', 8, finite, 'a finite number'),
    amplitude = option(options.amplitude, 'amplitude', 32, (v) => v >= 0 && finite(v), 'a finite number >= 0'),
    scale = option(options.scale, 'scale', 192, (v) => v > 0 && finite(v), 'a finite number > 0'),
    caves = option(options.caves, 'caves', 0.3, (v) => v >= 0 && v <= 1, '0..1'),
    trees = option(options.trees, 'trees', 0.01, (v) => v >= 0 && v <= 1, '0..1'),
    given = options.blocks ?? {};
  if (!given || typeof given !== 'object') throw new TypeError('NoiseTerrainOptions.blocks must be an object of names');
  const names = NAMES.map((key) => {
    const name = given[key] ?? key;
    if (typeof name !== 'string') throw new TypeError(`NoiseTerrainOptions.blocks.${key} must be a block type name`);
    return name;
  });
  const ground = new Noise(seed),
    tunnelA = new Noise(seed ^ 0x5bd1e995),
    tunnelB = new Noise(seed ^ 0x1b873593),
    relief = fbm((x, z) => ground.simplex2(x, z), { octaves: 5, frequency: 1 / scale }),
    surface = (x: number, z: number) => Math.floor(height + amplitude * relief(x, z)),
    // Tunnels: |a| and |b| both under `width`, so the zero sheets of two fields cross in winding tubes.
    width = 0.3 * caves,
    treeCut = trees * 4294967296;

  return (chunk, cx, cy, cz, context) => {
    if (!Array.isArray(context?.blocks))
      throw new TypeError('noiseTerrain needs context {blocks}: the world BlockTypes table');
    const byName = new Map(context.blocks.map((type) => [type.name, type.id])),
      ids = names.map((name, i) => {
        const id = byName.get(name);
        if (id === undefined && (i < 5 || trees > 0))
          throw new RangeError(
            `noiseTerrain block "${name}" is not defined; define it with blocks.define("${name}") or name another type in NoiseTerrainOptions.blocks.${NAMES[i]}`,
          );
        return id ?? 0;
      }),
      [stone, dirt, grass, sand, water, log, leaves] = ids,
      x0 = cx * 32,
      y0 = cy * 32,
      z0 = cz * 32,
      y1 = y0 + 31,
      heights = new Int32Array(W * W),
      known = new Uint8Array(W * W),
      // Column heights within R of the chunk come first; those up to 2R out only when a tree there needs them.
      heightAt = (i: number, j: number): number => {
        const k = i + j * W;
        if (!known[k]) {
          known[k] = 1;
          heights[k] = surface(x0 + i - M, z0 + j - M);
        }
        return heights[k];
      };
    let low = Infinity,
      high = -Infinity;
    for (let j = M - R; j < W - M + R; j++)
      for (let i = M - R; i < W - M + R; i++) {
        const h = heightAt(i, j);
        if (i >= M && j >= M && i < 32 + M && j < 32 + M) {
          low = Math.min(low, h);
          high = Math.max(high, h);
        }
      }

    // Ground and sea.
    if (y1 < low - 3) chunk.fill(stone);
    else if (y0 > high && y1 <= seaLevel) chunk.fill(water);
    else if (y0 <= Math.max(high, seaLevel))
      for (let z = 0; z < 32; z++)
        for (let x = 0; x < 32; x++) {
          const h = heights[x + M + (z + M) * W],
            top = Math.min(y1, Math.max(h, seaLevel));
          for (let y = y0; y <= top; y++)
            chunk.set(
              x,
              y - y0,
              z,
              y < h - 3 ? stone : y < h ? dirt : y === h ? (h <= seaLevel + 1 ? sand : grass) : water,
            );
        }

    // Caves: both fields sampled on a 4-block world grid (9^3 per chunk, shared with the neighbours) and blended.
    if (width > 0 && y0 < high) {
      const a = new Float64Array(729),
        b = new Float64Array(729);
      for (let k = 0, s = 0; k < 9; k++)
        for (let j = 0; j < 9; j++)
          for (let i = 0; i < 9; i++, s++) {
            const x = (x0 + 4 * i) / 64,
              y = (y0 + 4 * j) / 40,
              z = (z0 + 4 * k) / 64;
            a[s] = tunnelA.simplex(x, y, z);
            b[s] = tunnelB.simplex(x, y, z);
          }
      for (let z = 0; z < 32; z++)
        for (let x = 0; x < 32; x++) {
          const c = x + M + (z + M) * W,
            top = Math.min(31, heights[c] - 1 - y0),
            // Rock at a height where a side neighbour column holds sea (above its ground, at or below seaLevel) stays,
            // so water never borders a cave. Above a cave cell its own column is ground: the top block is never carved.
            side = Math.min(heights[c - 1], heights[c + 1], heights[c - W], heights[c + W]);
          for (let y = 0; y <= top; y++) {
            if (y + y0 > side && y + y0 <= seaLevel) continue;
            if (Math.abs(blend(a, x, y, z)) < width && Math.abs(blend(b, x, y, z)) < width) chunk.set(x, y, z, 0);
          }
        }
    }

    // Trees: logs replace air and leaves, leaves fill air only, so overlapping trees give the same cells in any order.
    // A tree grows only where its whole crown is in the open air above the ground of every column it covers (no
    // leaves in a hillside or a cave); that depends on the heights within R of its column alone.
    if (treeCut > 0)
      for (let j = M - R; j < W - M + R; j++)
        for (let i = M - R; i < W - M + R; i++) {
          const wx = x0 + i - M,
            wz = z0 + j - M,
            r = hash(wx, wz, seed),
            h = heights[i + j * W];
          if (r >= treeCut || h <= seaLevel + 1) continue;
          const top = h + 4 + (r % 3), // trunk of 4-6 logs on the grass at h
            lx = wx - x0,
            lz = wz - z0;
          if (top + 1 < y0 || h + 1 > y1) continue;
          let open = true;
          for (let dz = -R; dz <= R && open; dz++)
            for (let dx = -R; dx <= R; dx++)
              if (Math.abs(dx) + Math.abs(dz) < 4 && heightAt(i + dx, j + dz) >= top - 2) open = false;
          if (!open) continue;
          const put = (x: number, y: number, z: number, state: number) => {
            if ((x & 31) !== x || (y & 31) !== y || (z & 31) !== z) return;
            const was = chunk.get(x, y, z);
            if (was === 0 || (state === log && was === leaves)) chunk.set(x, y, z, state);
          };
          for (let dy = -2; dy <= 1; dy++)
            for (let dz = -R; dz <= R; dz++)
              for (let dx = -R; dx <= R; dx++)
                if (dy < 0 ? Math.abs(dx) + Math.abs(dz) < 4 : Math.abs(dx) + Math.abs(dz) < 2)
                  put(lx + dx, top + dy - y0, lz + dz, leaves);
          for (let y = h + 1; y <= top; y++) put(lx, y - y0, lz, log);
        }
  };
}
