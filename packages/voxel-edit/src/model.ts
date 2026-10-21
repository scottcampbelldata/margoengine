// Modeling operations on dense grids: combine, shear, reflect, wrap, repeat, resample, rotate, grow, shrink, fill.
import type { Vec3 } from '@margoengine/math';
import { createRandom } from '@margoengine/math/mathutils';
import {
  axisIndex,
  cellLimit,
  checkCell,
  checkGrid,
  checkOptions,
  checkPalette,
  edited,
  type GridEdit,
  type GridLimits,
  sizeCells,
  type VoxelGrid,
} from './grid.js';

/** Options of {@link combineGrids}. */
export interface CombineOptions extends GridLimits {
  /**
   * `'union'` adds the tool's filled cells, `'intersect'` keeps base cells only under filled tool cells, `'subtract'`
   * empties base cells under filled tool cells. The result keeps the base's size.
   */
  operation: 'union' | 'intersect' | 'subtract';
  /** Where the tool's cell (0, 0, 0) lands in the base, in whole cells. Default [0, 0, 0]. */
  offset?: Vec3;
  /**
   * Union only: the base palette index for each tool index, 256 entries. Entry 0 must stay 0 and every index the tool
   * uses must map to 1-255; {@link mergePalettes} builds one.
   */
  paletteMap?: Uint8Array;
  /** Union only: the index a cell filled in both keeps. Default `'base'`. */
  overlap?: 'base' | 'tool';
}

/**
 * Combines a tool grid into a base grid (boolean union, intersection or subtraction). `clipped` counts filled tool
 * cells that land outside the base.
 */
export function combineGrids(base: VoxelGrid, tool: VoxelGrid, options: CombineOptions): GridEdit {
  checkOptions(options, 'combineGrids');
  const limit = cellLimit(options);
  checkGrid(base, limit, 'Base grid');
  const toolCells = checkGrid(tool, limit, 'Tool grid'),
    operation = options.operation;
  if (operation !== 'union' && operation !== 'intersect' && operation !== 'subtract')
    throw new TypeError("combineGrids operation is unknown; pass 'union', 'intersect' or 'subtract'");
  const offset = options.offset ?? [0, 0, 0];
  checkCell(offset, 'combineGrids offset');
  if (options.overlap !== undefined && options.overlap !== 'base' && options.overlap !== 'tool')
    throw new TypeError("combineGrids overlap is unknown; pass 'base' or 'tool'");
  const map = options.paletteMap;
  if (operation === 'union') {
    if (!(map instanceof Uint8Array) || map.length !== 256)
      throw new TypeError('combineGrids union needs a paletteMap; pass 256 entries (see mergePalettes)');
    if (map[0] !== 0) throw new RangeError('combineGrids paletteMap fills air; keep entry 0 at 0');
    for (let i = 0; i < toolCells; i++)
      if (tool.voxels[i] && !map[tool.voxels[i]])
        throw new RangeError(`combineGrids paletteMap empties tool index ${tool.voxels[i]}; map it to 1-255`);
  }
  const [sx, sy, sz] = base.size,
    [tx, ty, tz] = tool.size,
    [ox, oy, oz] = offset,
    toolWins = options.overlap === 'tool',
    voxels = base.voxels.slice();
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const bx = x - ox,
          by = y - oy,
          bz = z - oz,
          other =
            bx >= 0 && by >= 0 && bz >= 0 && bx < tx && by < ty && bz < tz ? tool.voxels[bx + tx * (bz + tz * by)] : 0,
          index = x + sx * (z + sz * y);
        if (operation === 'union') {
          if (other && (toolWins || !voxels[index])) voxels[index] = map![other];
        } else if (operation === 'intersect' ? !other : other) voxels[index] = 0;
      }
  let clipped = 0;
  for (let y = 0; y < ty; y++)
    for (let z = 0; z < tz; z++)
      for (let x = 0; x < tx; x++) {
        if (!tool.voxels[x + tx * (z + tz * y)]) continue;
        const dx = x + ox,
          dy = y + oy,
          dz = z + oz;
        if (dx < 0 || dy < 0 || dz < 0 || dx >= sx || dy >= sy || dz >= sz) clipped++;
      }
  return edited(base, voxels, clipped);
}

/** Options of {@link shearGrid}. */
export interface ShearOptions extends GridLimits {
  /** The axis cells move along. */
  axis: 'x' | 'y' | 'z';
  /** The axis whose coordinate sets how far: a cell moves `round(factor * (coordinate - pivot))` along `axis`. */
  along: 'x' | 'y' | 'z';
  /** Cells moved per cell of `along`, finite. */
  factor: number;
  /** The `along` coordinate that stays put, finite. Default 0. */
  pivot?: number;
}

/**
 * Shears a grid by whole-cell layer shifts, keeping its size and colours (ties round up). `clipped` counts filled cells
 * shifted out of the grid.
 */
export function shearGrid(grid: VoxelGrid, options: ShearOptions): GridEdit {
  checkOptions(options, 'shearGrid');
  const cells = checkGrid(grid, cellLimit(options)),
    axis = axisIndex(options.axis, 'shearGrid axis'),
    along = axisIndex(options.along, 'shearGrid along'),
    factor = options.factor,
    pivot = options.pivot ?? 0;
  if (axis === along) throw new TypeError('shearGrid axis and along are the same; pass two different axes');
  if (!Number.isFinite(factor) || !Number.isFinite(pivot))
    throw new RangeError('shearGrid factor or pivot is not finite; pass finite numbers');
  for (const end of [0, grid.size[along] - 1])
    if (!Number.isSafeInteger(Math.round(factor * (end - pivot))))
      throw new RangeError('shearGrid shift exceeds safe integers; lower the factor or move the pivot');
  const [sx, sy, sz] = grid.size,
    voxels = new Uint8Array(cells),
    cell = [0, 0, 0];
  let clipped = 0;
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const value = grid.voxels[x + sx * (z + sz * y)];
        if (!value) continue;
        cell[0] = x;
        cell[1] = y;
        cell[2] = z;
        cell[axis] += Math.round(factor * (cell[along] - pivot));
        if (cell[axis] < 0 || cell[axis] >= grid.size[axis]) clipped++;
        else voxels[cell[0] + sx * (cell[2] + sz * cell[1])] = value;
      }
  return edited(grid, voxels, clipped);
}

/** Options of {@link reflectDiagonal}. */
export interface DiagonalOptions extends GridLimits {
  /** The plane holding the diagonal; its two axes must have the same size. */
  plane: 'xy' | 'xz' | 'yz';
  /** `'main'` swaps (a, b) to (b, a); `'anti'` maps (a, b) to (n - 1 - b, n - 1 - a). Default `'main'`. */
  diagonal?: 'main' | 'anti';
  /** `'mirror'` reflects every cell; `'symmetrize'` copies the `keep` half, air included, over the other. Default `'symmetrize'`. */
  mode?: 'mirror' | 'symmetrize';
  /**
   * The half `'symmetrize'` keeps: `'lower'` is a <= b on the main diagonal and a + b <= n - 1 on the anti diagonal,
   * `'upper'` the other side. Cells on the diagonal never change. Default `'lower'`.
   */
  keep?: 'lower' | 'upper';
}

/** Reflects a grid across a diagonal of one of its planes, or makes it symmetric about one. */
export function reflectDiagonal(grid: VoxelGrid, options: DiagonalOptions): GridEdit {
  checkOptions(options, 'reflectDiagonal');
  const cells = checkGrid(grid, cellLimit(options)),
    pair = ({ xy: [0, 1], xz: [0, 2], yz: [1, 2] } as const)[options.plane];
  if (!pair) throw new TypeError("reflectDiagonal plane is unknown; pass 'xy', 'xz' or 'yz'");
  const anti = (options.diagonal ?? 'main') === 'anti',
    mirror = (options.mode ?? 'symmetrize') === 'mirror',
    upper = (options.keep ?? 'lower') === 'upper';
  if (options.diagonal !== undefined && options.diagonal !== 'main' && options.diagonal !== 'anti')
    throw new TypeError("reflectDiagonal diagonal is unknown; pass 'main' or 'anti'");
  if (options.mode !== undefined && options.mode !== 'mirror' && options.mode !== 'symmetrize')
    throw new TypeError("reflectDiagonal mode is unknown; pass 'mirror' or 'symmetrize'");
  if (options.keep !== undefined && options.keep !== 'lower' && options.keep !== 'upper')
    throw new TypeError("reflectDiagonal keep is unknown; pass 'lower' or 'upper'");
  const [a, b] = pair,
    n = grid.size[a];
  if (grid.size[b] !== n)
    throw new RangeError(`reflectDiagonal needs a square ${options.plane} plane; resize it to ${n} x ${n}`);
  const [sx, sy, sz] = grid.size,
    voxels = new Uint8Array(cells),
    cell = [0, 0, 0];
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        cell[0] = x;
        cell[1] = y;
        cell[2] = z;
        const u = cell[a],
          v = cell[b],
          bound = anti ? n - 1 - v : v,
          kept = upper ? u >= bound : u <= bound;
        if (mirror || !kept) {
          cell[a] = anti ? n - 1 - v : v;
          cell[b] = anti ? n - 1 - u : u;
        }
        voxels[x + sx * (z + sz * y)] = grid.voxels[cell[0] + sx * (cell[2] + sz * cell[1])];
      }
  return edited(grid, voxels, 0);
}

/** Options of {@link wrapGrid}. */
export interface WrapOptions extends GridLimits {
  /** Whole cells to move along x, y and z; cells leaving one side come back on the other. */
  offset: Vec3;
}

/** Moves every cell by `offset` with wrap-around, so no cell is lost. */
export function wrapGrid(grid: VoxelGrid, options: WrapOptions): GridEdit {
  checkOptions(options, 'wrapGrid');
  const cells = checkGrid(grid, cellLimit(options));
  checkCell(options.offset, 'wrapGrid offset');
  const [sx, sy, sz] = grid.size,
    [dx, dy, dz] = options.offset.map((v, axis) => ((v % grid.size[axis]) + grid.size[axis]) % grid.size[axis]),
    voxels = new Uint8Array(cells);
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++)
        voxels[((x + dx) % sx) + sx * (((z + dz) % sz) + sz * ((y + dy) % sy))] = grid.voxels[x + sx * (z + sz * y)];
  return edited(grid, voxels, 0);
}

/** Options of {@link repeatGrid}. */
export interface RepeatOptions extends GridLimits {
  /** Copies along x, y and z, each a positive integer; the result is `size * counts`. */
  counts: Vec3;
}

/** Tiles a grid `counts` times along each axis, air and repeated palette indexes included. */
export function repeatGrid(grid: VoxelGrid, options: RepeatOptions): GridEdit {
  checkOptions(options, 'repeatGrid');
  const limit = cellLimit(options);
  checkGrid(grid, limit);
  checkCell(options.counts, 'repeatGrid counts');
  if (options.counts.some((v) => v < 1)) throw new RangeError('repeatGrid counts must be at least 1; pass 1 or more');
  const size: Vec3 = [
      grid.size[0] * options.counts[0],
      grid.size[1] * options.counts[1],
      grid.size[2] * options.counts[2],
    ],
    voxels = new Uint8Array(sizeCells(size, limit, 'repeatGrid result')),
    [sx, sy, sz] = size,
    [ox, oy, oz] = grid.size;
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++)
        voxels[x + sx * (z + sz * y)] = grid.voxels[(x % ox) + ox * ((z % oz) + oz * (y % oy))];
  return edited(grid, voxels, 0, size);
}

/** Options of {@link resampleGrid}. */
export interface ResampleOptions extends GridLimits {
  /** Scale along x, y and z, positive and finite; each new size is `round(size * scale)`, at least 1. */
  scale: Vec3;
}

/** Scales a grid by sampling the nearest source cell at each new cell's centre; palette indexes are never blended. */
export function resampleGrid(grid: VoxelGrid, options: ResampleOptions): GridEdit {
  checkOptions(options, 'resampleGrid');
  const limit = cellLimit(options);
  checkGrid(grid, limit);
  const scale = options.scale;
  if (!Array.isArray(scale) || scale.length !== 3)
    throw new TypeError('resampleGrid scale is not [x, y, z]; pass three numbers');
  if (!Array.from(scale).every((v) => Number.isFinite(v) && v > 0))
    throw new RangeError('resampleGrid scale must be positive and finite; pass three such numbers');
  const size: Vec3 = [0, 1, 2].map((axis) => Math.max(1, Math.round(grid.size[axis] * scale[axis]))) as unknown as Vec3,
    voxels = new Uint8Array(sizeCells(size, limit, 'resampleGrid result')),
    [sx, sy, sz] = size,
    [ox, oy, oz] = grid.size;
  for (let y = 0; y < sy; y++) {
    const fy = Math.min(oy - 1, Math.floor(((y + 0.5) * oy) / sy));
    for (let z = 0; z < sz; z++) {
      const fz = Math.min(oz - 1, Math.floor(((z + 0.5) * oz) / sz));
      for (let x = 0; x < sx; x++)
        voxels[x + sx * (z + sz * y)] =
          grid.voxels[Math.min(ox - 1, Math.floor(((x + 0.5) * ox) / sx)) + ox * (fz + oz * fy)];
    }
  }
  return edited(grid, voxels, 0, size);
}

/** Options of {@link rotateGrid}. */
export interface RotateOptions extends GridLimits {
  /** The axis to turn about, through the grid's centre. */
  axis: 'x' | 'y' | 'z';
  /** Right-handed turn in degrees, finite; any angle, not only quarter turns. */
  degrees: number;
}

/**
 * Rotates a grid about its centre inside its own box: each cell takes the source cell its centre turns back onto.
 * Quarter turns of a grid whose turned axes have the same size are exact. `clipped` counts filled cells whose turned
 * centre leaves the box.
 */
export function rotateGrid(grid: VoxelGrid, options: RotateOptions): GridEdit {
  checkOptions(options, 'rotateGrid');
  const cells = checkGrid(grid, cellLimit(options)),
    axis = axisIndex(options.axis, 'rotateGrid axis');
  if (!Number.isFinite(options.degrees)) throw new RangeError('rotateGrid degrees is not finite; pass a finite angle');
  const radians = ((options.degrees % 360) * Math.PI) / 180,
    // Exact quarter turns: snap only the trigonometric round-off, never the sampling grid.
    snap = (v: number) => (Math.abs(v) < 1e-12 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-12 ? Math.sign(v) : v),
    c = snap(Math.cos(radians)),
    s = snap(Math.sin(radians)),
    [sx, sy, sz] = grid.size,
    voxels = new Uint8Array(cells),
    // turn(p, sign): p turned by +angle (sign 1) or back by it (sign -1), about the axis, in centred coordinates.
    turn = (px: number, py: number, pz: number, sign: number, out: number[]) => {
      const t = s * sign;
      out[0] = axis === 0 ? px : axis === 1 ? c * px + t * pz : c * px - t * py;
      out[1] = axis === 0 ? c * py - t * pz : axis === 1 ? py : t * px + c * py;
      out[2] = axis === 0 ? t * py + c * pz : axis === 1 ? -t * px + c * pz : pz;
    },
    p = [0, 0, 0];
  let clipped = 0;
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        turn(x + 0.5 - sx / 2, y + 0.5 - sy / 2, z + 0.5 - sz / 2, -1, p);
        const ix = Math.floor(p[0] + sx / 2),
          iy = Math.floor(p[1] + sy / 2),
          iz = Math.floor(p[2] + sz / 2);
        if (ix >= 0 && iy >= 0 && iz >= 0 && ix < sx && iy < sy && iz < sz)
          voxels[x + sx * (z + sz * y)] = grid.voxels[ix + sx * (iz + sz * iy)];
        if (!grid.voxels[x + sx * (z + sz * y)]) continue;
        turn(x + 0.5 - sx / 2, y + 0.5 - sy / 2, z + 0.5 - sz / 2, 1, p);
        const fx = p[0] + sx / 2,
          fy = p[1] + sy / 2,
          fz = p[2] + sz / 2;
        if (fx < 0 || fy < 0 || fz < 0 || fx >= sx || fy >= sy || fz >= sz) clipped++;
      }
  return edited(grid, voxels, clipped);
}

/** Directions and passes of {@link dilateGrid} and {@link erodeGrid}. */
export interface MorphologyOptions extends GridLimits {
  /** Passes, 0 to 1024; each reads the result of the one before. Default 1. */
  iterations?: number;
  /** Unit axis vectors to grow toward or check, one to six. Default all six. */
  directions?: readonly Vec3[];
}

/** Options of {@link dilateGrid}. */
export interface DilateOptions extends MorphologyOptions {
  /** Palette index of the added cells, 1-255. Default: the index of the cell each one grew from. */
  color?: number;
}

const SIX: readonly Vec3[] = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
];
/** Cells times passes times directions one morphology call may visit. */
const MAX_WORK = 134_217_728;

function morphology(
  grid: VoxelGrid,
  options: MorphologyOptions,
  name: string,
  grow: boolean,
  color?: number,
): GridEdit {
  checkOptions(options, name);
  const cells = checkGrid(grid, cellLimit(options)),
    iterations = options.iterations ?? 1,
    directions = options.directions ?? SIX;
  if (!Array.isArray(directions) || directions.length < 1 || directions.length > 6)
    throw new TypeError(`${name} directions must hold one to six unit axis vectors; pass such a list`);
  for (const d of directions)
    if (
      !Array.isArray(d) ||
      d.length !== 3 ||
      !Array.from(d).every(Number.isInteger) ||
      Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) !== 1
    )
      throw new RangeError(`${name} direction ${JSON.stringify(d)} is not a unit axis vector; pass e.g. [1, 0, 0]`);
  if (!Number.isInteger(iterations) || iterations < 0 || iterations > 1024)
    throw new RangeError(`${name} iterations must be an integer from 0 to 1024; pass one`);
  if (cells * iterations * directions.length > MAX_WORK)
    throw new RangeError(`${name} work exceeds ${MAX_WORK} cell visits; use fewer iterations or directions`);
  const [sx, sy, sz] = grid.size;
  let current = grid.voxels.slice();
  for (let pass = 0; pass < iterations; pass++) {
    const next = current.slice();
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++) {
          const index = x + sx * (z + sz * y);
          if (!current[index]) continue;
          for (const [dx, dy, dz] of directions) {
            const nx = x + dx,
              ny = y + dy,
              nz = z + dz,
              inside = nx >= 0 && ny >= 0 && nz >= 0 && nx < sx && ny < sy && nz < sz,
              neighbour = inside ? nx + sx * (nz + sz * ny) : -1;
            if (grow) {
              if (inside && !current[neighbour] && !next[neighbour]) next[neighbour] = color ?? current[index];
            } else if (!inside || !current[neighbour]) {
              next[index] = 0;
              break;
            }
          }
        }
    current = next;
  }
  return edited(grid, current, 0);
}

/**
 * Grows filled cells into neighbouring air along `directions`. An added cell takes `color`, or without it the index
 * of the first cell (in grid order) that grew into it.
 */
export function dilateGrid(grid: VoxelGrid, options: DilateOptions = {}): GridEdit {
  checkOptions(options, 'dilateGrid');
  if (options.color !== undefined) checkPalette(options.color, 'dilateGrid color');
  return morphology(grid, options, 'dilateGrid', true, options.color);
}

/** Empties filled cells that have air (or the grid's edge) next to them along any of `directions`. */
export function erodeGrid(grid: VoxelGrid, options: MorphologyOptions = {}): GridEdit {
  return morphology(grid, options, 'erodeGrid', false);
}

/** Options of {@link fillEnclosed}. */
export interface FillOptions extends GridLimits {
  /** Palette index for the filled air, 1-255. */
  color: number;
}

/** Fills air that no face-connected path of air links to the grid's boundary (closed cavities) with `color`. */
export function fillEnclosed(grid: VoxelGrid, options: FillOptions): GridEdit {
  checkOptions(options, 'fillEnclosed');
  const cells = checkGrid(grid, cellLimit(options));
  checkPalette(options.color, 'fillEnclosed color');
  const [sx, sy, sz] = grid.size,
    plane = sx * sz,
    source = grid.voxels,
    outside = new Uint8Array(cells),
    queue = new Uint32Array(cells);
  let head = 0,
    tail = 0;
  const visit = (index: number) => {
    if (!outside[index] && !source[index]) {
      outside[index] = 1;
      queue[tail++] = index;
    }
  };
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++)
        if (x === 0 || y === 0 || z === 0 || x === sx - 1 || y === sy - 1 || z === sz - 1) visit(x + sx * (z + sz * y));
  while (head < tail) {
    const index = queue[head++],
      x = index % sx,
      z = Math.floor(index / sx) % sz,
      y = Math.floor(index / plane);
    if (x > 0) visit(index - 1);
    if (x < sx - 1) visit(index + 1);
    if (z > 0) visit(index - sx);
    if (z < sz - 1) visit(index + sx);
    if (y > 0) visit(index - plane);
    if (y < sy - 1) visit(index + plane);
  }
  const voxels = source.slice();
  for (let i = 0; i < cells; i++) if (!voxels[i] && !outside[i]) voxels[i] = options.color;
  return edited(grid, voxels, 0);
}

/** Inputs of {@link mergePalettes}. */
export interface PaletteMergeOptions {
  /** 256 identity strings of the base palette (colour plus material, say); equal strings mean the same entry. */
  baseKeys: readonly string[];
  /** 256 identity strings of the tool palette. */
  toolKeys: readonly string[];
  /** 256 entries, nonzero where the base grid uses that index; entry 0 must be 0. */
  baseUsed: Uint8Array;
  /** 256 entries, nonzero where the tool grid uses that index; entry 0 must be 0. */
  toolUsed: Uint8Array;
}

/** What {@link mergePalettes} returns. */
export interface PaletteMerge {
  /** Base index for each tool index, ready for {@link CombineOptions.paletteMap}. */
  paletteMap: Uint8Array;
  /** Each used tool index and the base index it maps to, in tool order; copy the tool's entry into new ones. */
  assignments: { from: number; to: number }[];
}

/**
 * Maps a tool palette into a base palette for {@link combineGrids}: tool entries whose identity the base already uses
 * reuse that index, the others take the lowest unused base indexes. Base entries in use never change. Throws a
 * RangeError when the merged palette would need more than 255 entries; nothing is approximated.
 */
export function mergePalettes(options: PaletteMergeOptions): PaletteMerge {
  checkOptions(options, 'mergePalettes');
  for (const keys of [options.baseKeys, options.toolKeys])
    if (!Array.isArray(keys) || keys.length !== 256 || keys.some((key) => typeof key !== 'string'))
      throw new TypeError('mergePalettes keys must be 256 strings per palette; pass baseKeys and toolKeys');
  for (const used of [options.baseUsed, options.toolUsed]) {
    if (!(used instanceof Uint8Array) || used.length !== 256)
      throw new TypeError('mergePalettes usage must be a 256-entry Uint8Array; pass baseUsed and toolUsed');
    if (used[0]) throw new RangeError('mergePalettes usage marks index 0 (air); clear entry 0');
  }
  const { baseKeys, toolKeys, baseUsed, toolUsed } = options,
    known = new Map<string, number>(),
    taken = baseUsed.slice(),
    missing = new Set<string>();
  let free = 255;
  for (let i = 1; i < 256; i++)
    if (baseUsed[i]) {
      free--;
      if (!known.has(baseKeys[i])) known.set(baseKeys[i], i);
    }
  for (let i = 1; i < 256; i++) if (toolUsed[i] && !known.has(toolKeys[i])) missing.add(toolKeys[i]);
  if (missing.size > free)
    throw new RangeError(
      `mergePalettes needs ${missing.size} new entries but only ${free} are free; use fewer colours or materials`,
    );
  const paletteMap = new Uint8Array(256),
    assignments: { from: number; to: number }[] = [];
  let next = 1;
  for (let from = 1; from < 256; from++) {
    if (!toolUsed[from]) continue;
    let to = known.get(toolKeys[from]);
    if (to === undefined) {
      while (taken[next]) next++;
      to = next;
      taken[to] = 1;
      known.set(toolKeys[from], to);
    }
    paletteMap[from] = to;
    assignments.push({ from, to });
  }
  return { paletteMap, assignments };
}

/** Options of {@link generateMaze}. */
export interface MazeOptions extends GridLimits {
  /** Rooms along x, a positive integer. */
  columns: number;
  /** Rooms along z, a positive integer. */
  rows: number;
  /** Wall height in cells, a positive integer. */
  wallHeight: number;
  /** Palette index of the walls, 1-255. */
  wallIndex: number;
  /** Palette index of a one-cell floor under the maze, 1-255, or 0 for none. Default 0. */
  floorIndex?: number;
  /** Unsigned 32-bit seed; the same seed gives the same maze. Default 0. */
  seed?: number;
  /** Open an entrance at (1, 0) and an exit at (width - 2, depth - 1). Default true. */
  openings?: boolean;
}

/** What {@link generateMaze} returns. */
export interface Maze {
  /** `2 * columns + 1` by `wallHeight` (+ 1 with a floor) by `2 * rows + 1` cells. */
  grid: VoxelGrid;
  /** `columns * rows`. */
  rooms: number;
  /** Openings between rooms, always `rooms - 1`: every room is reachable by exactly one path. */
  passages: number;
  /** The seed used. */
  seed: number;
}

/** Builds a perfect maze (seeded depth-first search) with one-cell walls and corridors, walls standing on y = 0 or the floor. */
export function generateMaze(options: MazeOptions): Maze {
  checkOptions(options, 'generateMaze');
  const limit = cellLimit(options),
    { columns, rows, wallHeight, wallIndex } = options,
    floorIndex = options.floorIndex ?? 0,
    seed = options.seed ?? 0;
  for (const [value, name] of [
    [columns, 'columns'],
    [rows, 'rows'],
    [wallHeight, 'wallHeight'],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`generateMaze ${name} must be a positive integer; pass one`);
  checkPalette(wallIndex, 'generateMaze wallIndex');
  checkPalette(floorIndex, 'generateMaze floorIndex', 0);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new RangeError('generateMaze seed must be an unsigned 32-bit integer; pass 0 to 4294967295');
  if (options.openings !== undefined && typeof options.openings !== 'boolean')
    throw new TypeError('generateMaze openings is not a boolean; pass true or false');
  const sx = columns * 2 + 1,
    sz = rows * 2 + 1,
    floor = floorIndex ? 1 : 0,
    size: Vec3 = [sx, wallHeight + floor, sz],
    voxels = new Uint8Array(sizeCells(size, limit, 'generateMaze result')),
    rooms = columns * rows,
    walls = new Uint8Array(sx * sz).fill(1),
    visited = new Uint8Array(rooms),
    stack = new Uint32Array(rooms),
    random = createRandom(seed),
    dx = [1, 0, -1, 0],
    dz = [0, 1, 0, -1];
  let depth = 1,
    passages = 0;
  visited[0] = 1;
  walls[1 + sx] = 0;
  while (depth) {
    const room = stack[depth - 1],
      x = room % columns,
      z = Math.floor(room / columns),
      open: number[] = [];
    for (let d = 0; d < 4; d++) {
      const nx = x + dx[d],
        nz = z + dz[d];
      if (nx >= 0 && nz >= 0 && nx < columns && nz < rows && !visited[nx + columns * nz]) open.push(d);
    }
    if (!open.length) {
      depth--;
      continue;
    }
    const d = open[Math.floor(random() * open.length)],
      nx = x + dx[d],
      nz = z + dz[d];
    walls[x * 2 + 1 + dx[d] + sx * (z * 2 + 1 + dz[d])] = 0;
    walls[nx * 2 + 1 + sx * (nz * 2 + 1)] = 0;
    visited[nx + columns * nz] = 1;
    stack[depth++] = nx + columns * nz;
    passages++;
  }
  if (options.openings !== false) {
    walls[1] = 0;
    walls[sx - 2 + sx * (sz - 1)] = 0;
  }
  if (floor) voxels.fill(floorIndex, 0, sx * sz);
  for (let y = floor; y < size[1]; y++)
    for (let i = 0; i < walls.length; i++) if (walls[i]) voxels[i + sx * sz * y] = wallIndex;
  return { grid: { size, voxels }, rooms, passages, seed };
}
