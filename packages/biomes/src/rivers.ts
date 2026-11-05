// Still river and lake water for a BiomeView (entry `@margoengine/biomes/rivers`, loaded only for a view with
// `water: { rivers }` or `water: { lakes }`): from river centre lines, lake levels and the world's heights, the water
// surface and the coarse ground `@margoengine/water` stands it on. A river's surface runs a fixed depth above the bed along
// each line, so it falls with the bed; a lake's is its fill level. The world's terrain hides the water wherever the real
// ground is above it, so the banks draw the edge, not this grid. Our own layout.
import { rangeError, typeError } from '../../shared/errors.js';
import type { Hydrology, HydrologyWorld } from './hydrology.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** Depth of a river over its bed in metres. */
export const RIVER_DEPTH = 1.5;
// Half width of the corridor in which the ground decides where the water stands, metres. Past it a valley stays dry.
const REACH = 48;
// The most water cells a side: the most `Water` couples to.
const MOST_CELLS = 512;

/** What {@link riverWater} reads. Lengths in metres, except the river lines. */
export interface RiverWaterSource {
  /** World rectangle `[x0, z0, x1, z1]`. */
  readonly bounds: readonly [number, number, number, number];
  /** Ground heights over `bounds`: `width` x `depth` corner samples, rows of increasing z. */
  readonly heights: Float32Array;
  readonly width: number;
  readonly depth: number;
  /** River centre lines in millimetres, `[x0, z0, x1, z1, ...]` (`BiomeWorld.rivers`, `Relief.rivers`). */
  readonly lines: readonly Int32Array[];
  /** Ground height at `(x, z)`. Read along the lines and over the cells near them. */
  readonly heightAt: (x: number, z: number) => number;
  /** Sea level. Water at it is the sea's: lines give no fill there. */
  readonly sea: number;
  /** Still lakes over a grid of corners from `bounds`' corner ({@link lakeLevels}). Default none. */
  readonly lakes?: LakeLevels;
}

/** Lake surfaces per grid corner, from {@link lakeLevels}. */
export interface LakeLevels {
  /** Corners a side, `step` mm apart, from the world's `[x0, z0]`. */
  readonly nx: number;
  readonly nz: number;
  readonly step: number;
  /** The surface in mm at each corner, rows of increasing z, or {@link NO_LAKE}. */
  readonly level: Int32Array;
}

/** A corner of {@link LakeLevels} with no lake. */
export const NO_LAKE = -2147483648;

/** What {@link lakeLevels} reads of a hydrology (`@margoengine/biomes/hydrology`). */
type LakeHydrology = Pick<Hydrology, 'nx' | 'nz' | 'step' | 'height' | 'filled' | 'lake'>;

/**
 * The lakes of a hydrology as still surfaces: each lake cell (fill depth past `lakeDepth`) and every cell of the same
 * flat fill joined to it takes the fill's surface, and the ring of dry corners around it holds that level, so the water's
 * mesh meets the shore at the surface and the terrain draws the edge. Integers only: the same hydrology, the same bytes.
 * @example
 * const lakes = lakeLevels(hydrologyOf(world));
 * const river = riverWater({ ...source, lines: [], lakes });
 */
export function lakeLevels(h: LakeHydrology): LakeLevels {
  const { nx, nz, step, height, filled, lake } = h,
    level = new Int32Array(nx * nz).fill(NO_LAKE),
    qx = new Int32Array(nx * nz),
    qz = new Int32Array(nx * nz);
  for (let s = 0, sz = 0; sz < nz; sz++)
    for (let sx = 0; sx < nx; sx++, s++) {
      if (!lake[s] || level[s] !== NO_LAKE) continue;
      // The flat fill around this lake cell, 8-connected: Priority-Flood makes a pit's fill one level up to its spill.
      const surface = filled[s];
      let tail = 1;
      level[s] = surface;
      qx[0] = sx;
      qz[0] = sz;
      for (let q = 0; q < tail; q++) {
        const x = qx[q],
          z = qz[q];
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            const u = x + dx,
              v = z + dz,
              d = v * nx + u;
            if (u < 0 || v < 0 || u >= nx || v >= nz || level[d] !== NO_LAKE) continue;
            if (filled[d] === surface && filled[d] > height[d]) {
              level[d] = surface;
              qx[tail] = u;
              qz[tail++] = v;
            }
          }
      }
    }
  // The dry ring: a neighbour of a lake stands at or above its surface, so holding the level there keeps the shore dry.
  const ring = level.slice();
  for (let z = 0, c = 0; z < nz; z++)
    for (let x = 0; x < nx; x++, c++) {
      if (level[c] !== NO_LAKE) continue;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const u = x + dx,
            v = z + dz;
          if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
          const l = level[v * nx + u];
          if (l > ring[c]) ring[c] = l;
        }
    }
  return { nx, nz, step, level: ring };
}

/** A view's choice of still water (`BiomeWaterSettings` of `@margoengine/biomes/view`). */
export interface ViewWaterChoice {
  /** `'auto'` the world's own lines, `'hydrology'` the channels of its hydrology (`riversOf`), or lines of your own. */
  readonly rivers?: 'auto' | 'hydrology' | readonly Int32Array[];
  /** `'auto'`: the lakes of the world's hydrology ({@link lakeLevels}). */
  readonly lakes?: 'auto' | false;
}

/**
 * The still water a view asks for: river lines and lakes, the hydrology entry loaded with import() only for
 * `'hydrology'` rivers or `'auto'` lakes. Undefined when that leaves no line and no lake.
 * @throws what {@link riverWater} throws.
 * @example
 * const water = await viewWater(world, { rivers: 'hydrology', lakes: 'auto' }, source, () => engine.gpu);
 * if (water) Water.attach(engine, { ...water.options, height: 0 });
 */
export async function viewWater(
  world: HydrologyWorld & { readonly rivers: readonly Int32Array[] },
  choice: ViewWaterChoice,
  source: Omit<RiverWaterSource, 'lines' | 'lakes'>,
  device: () => GPUDevice | undefined,
): Promise<ReturnType<typeof riverWaterOptions> | undefined> {
  const { rivers, lakes } = choice;
  let lines = rivers === 'auto' ? world.rivers : rivers === 'hydrology' ? [] : (rivers ?? []),
    levels: LakeLevels | undefined;
  if (rivers === 'hydrology' || lakes === 'auto') {
    const { hydrologyOf, riversOf } = await import('@margoengine/biomes/hydrology'),
      h = hydrologyOf(world);
    if (rivers === 'hydrology') lines = riversOf(world, h).lines;
    if (lakes === 'auto' && h.lake.includes(1)) levels = lakeLevels(h);
  }
  return lines.length || levels ? riverWaterOptions({ ...source, lines, lakes: levels }, device) : undefined;
}

/** The result of {@link riverWater}: the ground and the surface for a `Water`'s `terrain` and `fill`. */
export interface RiverWater {
  /** Water cells a side, 2..512. */
  readonly width: number;
  readonly depth: number;
  /**
   * Ground per cell, rows of increasing z: each cell the lowest of the heights under it, so a narrow valley is not lost,
   * cut to the bed under the line, and under a bank that climbs through the surface at the corridor's edge.
   */
  readonly ground: Float32Array;
  /** The water surface at world `(x, z)`, or undefined outside every corridor. */
  fill(x: number, z: number): number | undefined;
}

/**
 * Builds still river water: a surface {@link RIVER_DEPTH} over the ground along each line, in a corridor around it, and
 * the coarse ground it stands on, and with `lakes` each lake cell at its level where that is higher. Cells are the world
 * over at most 512 a side: a 4 km world has 8 m cells, an 8 km world 16 m. Cost on the calling thread: one height per
 * half cell of line and one per cell near it, and with lakes one look-up per cell.
 * @throws TypeError when a line is not an Int32Array of at least two points; RangeError for a bad grid or `bounds`.
 * @example
 * const river = riverWater({ bounds: world.bounds, heights, width, depth, lines: world.rivers, heightAt, sea: 0 });
 * Water.attach(engine, { terrain, fill: river.fill, still: true });
 */
export function riverWater(source: RiverWaterSource): RiverWater {
  const { bounds, heights, width, depth, lines, heightAt, sea } = source,
    [x0, z0, x1, z1] = bounds;
  if (!(x1 > x0 && z1 > z0) || !(width >= 2 && depth >= 2) || heights.length !== width * depth)
    throw rangeError(
      'riverWater needs bounds with x1 > x0 and z1 > z0, and width x depth heights of at least 2 x 2',
      'biomes',
    );
  const lakes = source.lakes;
  if (lakes && !(lakes.nx >= 1 && lakes.nz >= 1 && lakes.step >= 1 && lakes.level?.length === lakes.nx * lakes.nz))
    throw rangeError('riverWater lakes need nx x nz levels and a step of at least 1 mm (lakeLevels)', 'biomes');
  for (const line of lines)
    if (!(line instanceof Int32Array) || line.length < 4 || line.length % 2)
      throw typeError('River lines must be Int32Arrays of [x, z, ...] millimetres with at least two points', 'biomes');
  const nx = Math.min(MOST_CELLS, Math.max(2, width - 1)),
    nz = Math.min(MOST_CELLS, Math.max(2, depth - 1)),
    cx = (x1 - x0) / nx, // float division: metres
    cz = (z1 - z0) / nz, // float division: metres
    cell = Math.max(cx, cz),
    outer = REACH + 2 * cell,
    ground = new Float32Array(nx * nz),
    nearest = new Float64Array(nx * nz).fill(Infinity),
    levels = new Float32Array(nx * nz).fill(Number.NaN);
  // The lowest corner under each cell.
  for (let j = 0; j < nz; j++) {
    const v0 = Math.floor((j * (depth - 1)) / nz), // float division: grid index
      v1 = Math.ceil(((j + 1) * (depth - 1)) / nz); // float division: grid index
    for (let i = 0; i < nx; i++) {
      const u0 = Math.floor((i * (width - 1)) / nx), // float division: grid index
        u1 = Math.ceil(((i + 1) * (width - 1)) / nx); // float division: grid index
      let low = Infinity;
      for (let v = v0; v <= v1; v++)
        for (let u = u0; u <= u1; u++) {
          const h = heights[v * width + u];
          if (h < low) low = h;
        }
      ground[j * nx + i] = low;
    }
  }
  const lowest = source.lakes ? ground.slice() : undefined;
  // Each cell takes the surface of its nearest point along the lines.
  const step = Math.min(cx, cz) / 2; // float division: half a cell
  for (const line of lines)
    for (let k = 0; k + 3 < line.length; k += 2) {
      const ax = line[k] / 1000, // float division: millimetres to metres
        az = line[k + 1] / 1000, // float division
        bx = line[k + 2] / 1000, // float division
        bz = line[k + 3] / 1000, // float division
        count = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step)); // float division: sample count
      for (let s = 0; s <= count; s++) {
        const t = s / count, // float division: along the segment
          x = ax + (bx - ax) * t,
          z = az + (bz - az) * t;
        if (x < x0 || z < z0 || x > x1 || z > z1) continue;
        const level = heightAt(x, z) + RIVER_DEPTH;
        if (level <= sea) continue;
        const i0 = Math.max(0, Math.floor((x - outer - x0) / cx)), // float division: cell index
          i1 = Math.min(nx - 1, Math.floor((x + outer - x0) / cx)), // float division: cell index
          j0 = Math.max(0, Math.floor((z - outer - z0) / cz)), // float division: cell index
          j1 = Math.min(nz - 1, Math.floor((z + outer - z0) / cz)); // float division: cell index
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            const dx = x0 + (i + 0.5) * cx - x,
              dz = z0 + (j + 0.5) * cz - z,
              d = dx * dx + dz * dz,
              c = j * nx + i;
            if (d < nearest[c] && d <= outer * outer) {
              nearest[c] = d;
              levels[c] = level;
            }
          }
      }
    }
  // Under the line the bed, always; out to REACH the ground decides, under a bank that climbs through the surface at REACH,
  // so the waterline is smooth between cells; past it the ring is dry and holds the level.
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (nearest[c] === Infinity) continue;
      const d = Math.sqrt(nearest[c]),
        level = levels[c],
        bank = level + ((d - REACH) * RIVER_DEPTH) / (2 * cell); // float division: the bank's slope
      if (d > REACH) {
        if (ground[c] < bank) ground[c] = bank;
        continue;
      }
      const h = heightAt(x0 + (i + 0.5) * cx, z0 + (j + 0.5) * cz);
      ground[c] = Math.max(bank, d <= 1.5 * cell ? Math.min(h, level - RIVER_DEPTH) : h);
    }
  // A lake's surface wins where it is the higher one, over the lowest ground under the cell (no river bank in a lake).
  if (source.lakes && lowest) {
    const { nx: lx, nz: lz, step: ls, level: lake } = source.lakes;
    for (let j = 0; j < nz; j++) {
      const v = Math.min(lz - 1, Math.max(0, Math.round(((j + 0.5) * cz * 1000) / ls))); // float division: nearest corner
      for (let i = 0; i < nx; i++) {
        const u = Math.min(lx - 1, Math.max(0, Math.round(((i + 0.5) * cx * 1000) / ls))), // float division: nearest corner
          l = lake[v * lx + u],
          m = l / 1000, // float division: mm to metres
          c = j * nx + i;
        if (l === NO_LAKE || m <= sea || levels[c] >= m) continue;
        levels[c] = m;
        ground[c] = lowest[c];
      }
    }
  }
  return {
    width: nx,
    depth: nz,
    ground,
    fill(x, z) {
      const i = Math.floor((x - x0) / cx), // float division: cell index
        j = Math.floor((z - z0) / cz); // float division: cell index
      if (i < 0 || j < 0 || i >= nx || j >= nz) return undefined;
      const level = levels[j * nx + i];
      return Number.isNaN(level) ? undefined : level;
    },
  };
}

/**
 * `Water` options for still river water and the ground texture behind them: pass `options` to `Water.attach`, call
 * `dispose` with the water. The texture is made on `device()`'s device when the water asks for it, and again after a
 * device restore.
 * @throws what {@link riverWater} throws.
 * @example
 * const river = riverWaterOptions({ bounds: world.bounds, heights, width, depth, lines: world.rivers, heightAt, sea: 0 }, () => engine.gpu);
 * const water = Water.attach(engine, { ...river.options, height: 0 });
 */
export function riverWaterOptions(
  source: RiverWaterSource,
  device: () => GPUDevice | undefined,
): {
  readonly options: {
    readonly terrain: {
      readonly heightmap: () => GPUTexture | undefined;
      readonly origin: readonly [number, number];
      readonly size: readonly [number, number];
    };
    readonly fill: RiverWater['fill'];
    readonly still: true;
  };
  dispose(): void;
} {
  const river = riverWater(source),
    [x0, z0, x1, z1] = source.bounds;
  let made: { device: GPUDevice; texture: GPUTexture } | undefined;
  return {
    options: {
      terrain: {
        heightmap() {
          const gpu = device();
          if (gpu && made?.device !== gpu) {
            const size = [river.width, river.depth],
              texture = gpu.createTexture({
                size,
                format: 'r32float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
              });
            gpu.queue.writeTexture(
              { texture },
              river.ground as Float32Array<ArrayBuffer>,
              { bytesPerRow: river.width * 4 },
              size,
            );
            made = { device: gpu, texture };
          }
          return made?.texture;
        },
        origin: [x0, z0],
        size: [x1 - x0, z1 - z0],
      },
      fill: river.fill,
      still: true,
    },
    dispose() {
      made?.texture.destroy();
      made = undefined;
    },
  };
}
