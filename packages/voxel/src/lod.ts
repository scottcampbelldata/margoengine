// @margoengine/voxel/lod: far chunk levels of detail. Level L (1..levels) is a coarse VoxelWorld whose cell covers
// 2^L blocks per axis, so one of its 32-cubed chunks (a node) covers 32 * 2^L blocks and meshes and draws like any
// chunk (VoxelRenderer with `scale: 2^L`). Nodes form an octree: a node of level L >= 2 is split into its 8 children
// when the eye is nearer than `radius` child sizes (Chebyshev distance to its box), so every level adds a ring of
// about the same number of nodes and the view distance doubles per level at the same cost. Level 1 fills everything
// inside the level-2 ring, its cells over chunks the real world has loaded left empty, so the real chunks and the
// coarse ones never overlap and there is no hole where a chunk has not loaded yet.
import { fbm, Noise } from '@margoengine/procedural/noise';
import { uniformState, VoxelChunk } from './chunk.js';
import type { NoiseTerrainOptions, VoxelGenerateContext } from './generate.js';
import { chunkKey, VoxelWorld } from './world.js';

type Vec3 = readonly [number, number, number] | ArrayLike<number>;

/**
 * Fills `chunk`, a new air chunk, with node (x, y, z) of a far level: its cell (i, j, k) covers the `scale`-cubed
 * blocks from (32 x + i) * scale, (32 y + j) * scale, (32 z + k) * scale. It must give the same cells for the same
 * node every time. Light can stay 0 (attach `VoxelLighting` to the level's world).
 */
export type VoxelLodGenerate = (
  chunk: VoxelChunk,
  x: number,
  y: number,
  z: number,
  scale: number,
  context: VoxelGenerateContext,
) => void;

/** Options of {@link VoxelLod}. */
export interface VoxelLodOptions {
  /** The real world (level 0): level 1 leaves its loaded chunks' cells empty. Its `blocks` are the levels' blocks. */
  world: VoxelWorld;
  /** Fills far nodes, such as {@link noiseTerrainLod} with the streamer's terrain options. */
  generate: VoxelLodGenerate;
  /** Far levels, an integer in 1..12. Default 4. */
  levels?: number;
  /**
   * Nodes of a level from the eye before the next coarser level takes over, an integer in 2..32: level L reaches
   * `radius * 32 * 2^L` blocks, so the view reaches `radius * 32 * 2^levels`. Level 1 must cover the chunks the real
   * world streams: keep `2 * radius` above the streamer's `distance` + 1. Default 8 (4,096 blocks with 4 levels).
   */
  radius?: number;
  /** Lowest block y the far levels hold. Default -64. */
  minY?: number;
  /** Highest block y the far levels hold. Default 255. */
  maxY?: number;
  /** Most nodes generated or re-masked per {@link VoxelLod.update}, an integer >= 1 or Infinity. Default 8. */
  budget?: number;
}

/** One far level of a {@link VoxelLod}. */
export interface VoxelLodLevel {
  /** 1 to `levels`. */
  readonly level: number;
  /** Blocks per cell: 2^level. Pass it as `VoxelRenderer` option `scale`. */
  readonly scale: number;
  /** The level's coarse world: its chunks are the level's nodes on show. */
  readonly world: VoxelWorld;
}

/** What a {@link VoxelLod} holds. */
export interface VoxelLodStats {
  /** Nodes on show per level (index 0 is level 1). */
  readonly nodes: readonly number[];
  /** Wanted nodes not generated yet. */
  readonly pending: number;
}

// A node a level holds: the generated cells (level 1 keeps them to mask again), and whether it is in the level world.
interface Held {
  x: number;
  y: number;
  z: number;
  cells?: VoxelChunk;
  shown: boolean;
}
interface Want {
  level: number;
  x: number;
  y: number;
  z: number;
  key: string;
  d: number;
}

const whole = (name: string, value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number') throw new TypeError(`VoxelLod ${name} must be a number`);
  if (!(value === max || (Number.isInteger(value) && value >= min && value <= max)))
    throw new RangeError(`VoxelLod ${name} is ${value}; pass an integer in ${min}..${max}`);
  return value;
};

// Chebyshev distance from (ex, ey, ez) to the box [lo, lo + size) per axis (0 inside).
const gap = (e: number, lo: number, size: number): number => Math.max(lo - e, e - (lo + size), 0);

/**
 * Far chunk levels of detail for a block world: coarse copies of the terrain around the eye, each level's cells twice
 * the size of the one before, kept as `VoxelWorld`s that `VoxelRenderer` draws with `scale` and `VoxelLighting`
 * lights. Call {@link VoxelLod.update} every frame with the eye.
 */
export class VoxelLod {
  /** Far levels, coarsest last. */
  readonly levels: readonly VoxelLodLevel[];
  readonly #world: VoxelWorld;
  readonly #generate: VoxelLodGenerate;
  readonly #radius: number;
  readonly #minY: number;
  readonly #maxY: number;
  readonly #held: Map<string, Held>[];
  readonly #remask = new Set<string>();
  readonly #off: () => void;
  #pending = 0;
  #disposed = false;
  /** Most nodes generated or re-masked per update. Live. */
  budget: number;

  /**
   * @throws TypeError when `world` is not a VoxelWorld, `generate` not a function or an option not a number.
   * @throws RangeError for an option out of range, or `minY` above `maxY`.
   */
  constructor(options: VoxelLodOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('VoxelLod expects {world, generate}');
    const { world, generate, levels = 4, radius = 8, minY = -64, maxY = 255, budget = 8 } = options;
    if (!(world instanceof VoxelWorld)) throw new TypeError('VoxelLod world must be the real VoxelWorld');
    if (typeof generate !== 'function')
      throw new TypeError('VoxelLod generate must be a function, such as noiseTerrainLod(terrainOptions)');
    whole('levels', levels, 1, 12);
    this.#radius = whole('radius', radius, 2, 32);
    this.#minY = whole('minY', minY, -32768, 32767);
    this.#maxY = whole('maxY', maxY, -32768, 32767);
    if (minY > maxY) throw new RangeError(`VoxelLod minY ${minY} is above maxY ${maxY}; pass minY <= maxY`);
    this.budget = whole('budget', budget, 1, Infinity);
    this.#world = world;
    this.#generate = generate;
    this.levels = Array.from({ length: levels }, (_, i) => ({
      level: i + 1,
      scale: 2 ** (i + 1),
      world: new VoxelWorld({ blocks: world.blocks }),
    }));
    this.#held = this.levels.map(() => new Map());
    // A real chunk loading or unloading changes which level-1 cells are left empty.
    this.#off = world.onChunk((cx, cy, cz) => {
      const key = chunkKey(cx >> 1, cy >> 1, cz >> 1);
      if (this.#held[0].has(key)) this.#remask.add(key);
    });
  }

  /** Nodes on show per level and wanted nodes still to generate. */
  get stats(): VoxelLodStats {
    const nodes = this.#held.map((held) => {
      let n = 0;
      for (const node of held.values()) n += +node.shown;
      return n;
    });
    return { nodes, pending: this.#pending + this.#remask.size };
  }

  /**
   * Chooses the nodes for `eye` (blocks) and generates or re-masks up to `budget` of the missing ones, nearest first.
   * A node no longer wanted leaves its level once no missing node overlaps it, so a level change never opens a hole.
   * Returns the nodes generated or re-masked: 0 once everything is current.
   * @throws TypeError when `eye` is not three numbers or after `dispose()`; errors of `generate` propagate.
   */
  update(eye: Vec3): number {
    if (this.#disposed) throw new TypeError('VoxelLod is disposed; create a new VoxelLod');
    const ex = Number(eye?.[0]),
      ey = Number(eye?.[1]),
      ez = Number(eye?.[2]);
    if (![ex, ey, ez].every(Number.isFinite)) throw new TypeError('VoxelLod.update expects the eye as [x, y, z]');
    const wanted = this.levels.map(() => new Map<string, Want>()),
      r = this.#radius,
      top = this.levels.length,
      visit = (level: number, x: number, y: number, z: number): void => {
        const size = 32 << level,
          d = Math.max(gap(ex, x * size, size), gap(ey, y * size, size), gap(ez, z * size, size));
        if (level >= 2 && d < (r * size) / 2) {
          for (let k = 0; k < 8; k++) visit(level - 1, 2 * x + (k & 1), 2 * y + ((k >> 1) & 1), 2 * z + (k >> 2));
          return;
        }
        if ((y + 1) * size <= this.#minY || y * size > this.#maxY) return;
        const key = chunkKey(x, y, z);
        wanted[level - 1].set(key, { level, x, y, z, key, d });
      };
    // Top-level nodes within radius sizes of the eye.
    const size = 32 << top,
      reach = r * size,
      lo = (e: number) => Math.floor((e - reach) / size),
      hi = (e: number) => Math.floor((e + reach) / size),
      ylo = Math.max(lo(ey), Math.floor(this.#minY / size)),
      yhi = Math.min(hi(ey), Math.floor(this.#maxY / size));
    for (let x = lo(ex); x <= hi(ex); x++)
      for (let z = lo(ez); z <= hi(ez); z++)
        for (let y = ylo; y <= yhi; y++) {
          const d = Math.max(gap(ex, x * size, size), gap(ey, y * size, size), gap(ez, z * size, size));
          if (d < reach) visit(top, x, y, z);
        }

    // Missing nodes, nearest first; then the stale ones that no missing node overlaps.
    const missing: Want[] = [];
    for (let l = 0; l < top; l++)
      for (const want of wanted[l].values()) if (!this.#held[l].has(want.key)) missing.push(want);
    missing.sort((a, b) => a.d - b.d);
    let done = 0;
    for (const want of missing) {
      if (done >= this.budget) break;
      this.#make(want);
      done++;
    }
    for (const key of this.#remask) {
      if (done >= this.budget) break;
      this.#remask.delete(key);
      const held = this.#held[0].get(key);
      if (held) this.#show(1, held);
      done++;
    }
    const left = missing.filter((want) => !this.#held[want.level - 1].has(want.key));
    this.#pending = left.length;
    for (let l = 0; l < top; l++) {
      const scale = 32 << (l + 1);
      for (const [key, held] of this.#held[l]) {
        if (wanted[l].has(key)) continue;
        const x0 = held.x * scale,
          y0 = held.y * scale,
          z0 = held.z * scale,
          covered = left.some((w) => {
            const s = 32 << w.level;
            return (
              w.x * s < x0 + scale &&
              x0 < (w.x + 1) * s &&
              w.y * s < y0 + scale &&
              y0 < (w.y + 1) * s &&
              w.z * s < z0 + scale &&
              z0 < (w.z + 1) * s
            );
          });
        if (covered) continue;
        this.#held[l].delete(key);
        this.#remask.delete(key);
        if (held.shown) this.levels[l].world.removeChunk(held.x, held.y, held.z);
      }
    }
    return done;
  }

  #make({ level, x, y, z, key }: Want): void {
    const cells = new VoxelChunk(),
      scale = 2 ** level;
    this.#generate(cells, x, y, z, scale, { blocks: this.#world.blocks.table });
    const held: Held = { x, y, z, cells: uniformState(cells) === 0 ? undefined : cells, shown: false };
    this.#held[level - 1].set(key, held);
    this.#show(level, held);
  }

  // Puts a node's cells in its level world: on level 1 a copy with the cells over loaded real chunks emptied.
  #show(level: number, held: Held): void {
    const world = this.levels[level - 1].world,
      { x, y, z } = held;
    let cells = held.cells;
    if (cells && level === 1) {
      let copy: VoxelChunk | undefined;
      for (let k = 0; k < 8; k++) {
        const dx = k & 1,
          dy = (k >> 1) & 1,
          dz = k >> 2;
        if (!this.#world.getChunk(2 * x + dx, 2 * y + dy, 2 * z + dz)) continue;
        copy ??= VoxelChunk.unpack(cells.pack());
        for (let j = 0; j < 16; j++)
          for (let k2 = 0; k2 < 16; k2++)
            for (let i = 0; i < 16; i++) copy.set(16 * dx + i, 16 * dy + j, 16 * dz + k2, 0);
      }
      if (copy) cells = uniformState(copy) === 0 ? undefined : copy;
    }
    if (held.shown) world.removeChunk(x, y, z);
    held.shown = !!cells;
    if (cells) world.addChunk(x, y, z, cells === held.cells ? VoxelChunk.unpack(cells.pack()) : cells);
  }

  /** Stops following the real world's chunk loads and drops every node. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#off();
    for (let l = 0; l < this.levels.length; l++) {
      for (const held of this.#held[l].values())
        if (held.shown) this.levels[l].world.removeChunk(held.x, held.y, held.z);
      this.#held[l].clear();
    }
    this.#remask.clear();
  }
}

const TERRAIN = ['stone', 'dirt', 'grass', 'sand', 'water'] as const;

/**
 * The far-level form of `noiseTerrain` (`@margoengine/voxel/generate`) with the same options: the same ground and sea,
 * each coarse column taking the ground height at its centre block, rounded to the nearest whole cell (so a coarse
 * surface is within half a cell of the real one there). Caves and trees are left out: from where a level is drawn a
 * cave is not seen and a tree is under a cell.
 * @throws TypeError or RangeError as `noiseTerrain` for the options; the returned function throws RangeError for a
 * block name the context does not define.
 */
export function noiseTerrainLod(options: NoiseTerrainOptions = {}): VoxelLodGenerate {
  if (!options || typeof options !== 'object') throw new TypeError('noiseTerrainLod options must be an object');
  const num = (name: keyof NoiseTerrainOptions, fallback: number, ok: (v: number) => boolean, what: string) => {
      const v = options[name] ?? fallback;
      if (typeof v !== 'number') throw new TypeError(`NoiseTerrainOptions.${name} must be a number`);
      if (!ok(v)) throw new RangeError(`NoiseTerrainOptions.${name} is ${v}; pass ${what}`);
      return v;
    },
    finite = Number.isFinite,
    seed = num('seed', 1, (v) => (v | 0) === v, 'an integer in -2^31..2^31-1'),
    seaLevel = num('seaLevel', 0, (v) => (v | 0) === v, 'an integer cell y'),
    height = num('height', 8, finite, 'a finite number'),
    amplitude = num('amplitude', 32, (v) => v >= 0 && finite(v), 'a finite number >= 0'),
    scale = num('scale', 192, (v) => v > 0 && finite(v), 'a finite number > 0'),
    given = (options.blocks ?? {}) as Record<string, unknown>;
  const names = TERRAIN.map((key) => {
    const name = given[key] ?? key;
    if (typeof name !== 'string') throw new TypeError(`NoiseTerrainOptions.blocks.${key} must be a block type name`);
    return name;
  });
  const ground = new Noise(seed),
    relief = fbm((x, z) => ground.simplex2(x, z), { octaves: 5, frequency: 1 / scale }),
    surface = (x: number, z: number) => Math.floor(height + amplitude * relief(x, z)),
    tops = new Int32Array(1024),
    beach = new Uint8Array(1024);
  return (chunk, x, y, z, s, context) => {
    const byName = new Map(context.blocks.map((type) => [type.name, type.id])),
      [stone, dirt, grass, sand, water] = names.map((name) => {
        const id = byName.get(name);
        if (id === undefined)
          throw new RangeError(
            `noiseTerrainLod block "${name}" is not defined; define it with blocks.define("${name}")`,
          );
        return id;
      }),
      x0 = x * 32 * s,
      y0 = y * 32 * s,
      z0 = z * 32 * s,
      half = s >> 1;
    // Each column's ground in whole cells of this node: the ground's top (h + 1) rounded to the nearest cell edge.
    const seaCells = Math.floor((seaLevel + 1 - y0 + half) / s),
      deep = Math.ceil(3 / s); // cells of dirt under the top cell (dirt is 3 blocks deep)
    let low = Infinity,
      high = seaCells;
    for (let k = 0; k < 32; k++)
      for (let i = 0; i < 32; i++) {
        const h = surface(x0 + i * s + half, z0 + k * s + half),
          up = Math.floor((h + 1 - y0 + half) / s);
        tops[i + 32 * k] = up;
        beach[i + 32 * k] = +(h <= seaLevel + 1);
        low = Math.min(low, up);
        high = Math.max(high, up);
      }
    if (high <= 0) return;
    if (low > 33 + deep) return chunk.fill(stone);
    for (let k = 0; k < 32; k++)
      for (let i = 0; i < 32; i++) {
        const up = tops[i + 32 * k],
          sandy = beach[i + 32 * k];
        for (let j = 0; j < Math.min(32, Math.max(up, seaCells)); j++)
          chunk.set(
            i,
            j,
            k,
            j >= up ? water : j === up - 1 ? (sandy ? sand : grass) : j >= up - 1 - deep ? dirt : stone,
          );
      }
  };
}
