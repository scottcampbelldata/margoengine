// Exact whole-cell layout operations on dense grids: principal flips, quarter turns that swap sizes, clipped shifts,
// occupied bounds, anchored crops and occupancy inversion. Each maps a selection and continuous points with the cells.
import type { MutableVec3, Vec3 } from '@margoengine/math';
import {
  axisIndex,
  cellLimit,
  checkCell,
  checkGrid,
  checkOptions,
  checkPalette,
  checkPoint,
  edited,
  type GridEdit,
  type GridLimits,
  sizeCells,
  type VoxelGrid,
} from './grid.js';

/** Options every layout operation takes. */
export interface GridLayoutOptions extends GridLimits {
  /** Selected cells of the input, as cell indexes; the result maps them too, selected air included. */
  selection?: Iterable<number>;
}

/** What a layout operation returns: a {@link GridEdit} plus the cell and point mapping it applied. */
export interface GridLayout extends GridEdit {
  /** The selected cells that stay inside, as indexes of the result, in input order; empty without a selection. */
  selection: Float64Array;
  /**
   * The same mapping for a continuous point in corner coordinates (a pivot or a joint): the input's (0, 0, 0) corner
   * and far corner map onto the result's box exactly as the cells do.
   */
  mapPoint(point: Vec3): MutableVec3;
}

/** Options of {@link flipGrid}. */
export interface FlipOptions extends GridLayoutOptions {
  /** The axis to reverse: cell `c` moves to `size - 1 - c`. */
  axis: 'x' | 'y' | 'z';
}

/** Options of {@link turnGrid}. */
export interface TurnOptions extends GridLayoutOptions {
  /** The axis to turn about. */
  axis: 'x' | 'y' | 'z';
  /** Right-handed quarter turns, any whole number (negative turns the other way). Default 1. */
  turns?: number;
}

/** Options of {@link shiftGrid}. */
export interface ShiftOptions extends GridLayoutOptions {
  /** Whole cells to move along x, y and z; cells leaving the box are dropped. */
  offset: Vec3;
}

/** Options of {@link cropGrid}. */
export interface CropOptions extends GridLayoutOptions {
  /** The input cell that becomes the result's (0, 0, 0); it may lie outside the input (the new cells are air). */
  origin: Vec3;
  /** Cells of the result along x, y and z, each at least 1. */
  size: Vec3;
}

/** Options of {@link invertGrid}. */
export interface InvertOptions extends GridLimits {
  /** Palette index of the cells that were air, 1-255. */
  color: number;
}

type CellMap = (x: number, y: number, z: number, out: number[]) => void;

/** Moves every filled or selected cell of `grid` through `map` into a new grid of `size`. */
function layout(
  grid: VoxelGrid,
  options: GridLayoutOptions,
  size: Vec3,
  map: CellMap,
  mapPoint: (point: Vec3) => MutableVec3,
): GridLayout {
  const limit = cellLimit(options),
    cells = checkGrid(grid, limit),
    voxels = new Uint8Array(sizeCells(size, limit, 'Result size')),
    [sx, sy, sz] = grid.size,
    [rx, ry, rz] = size,
    selected = new Set<number>(),
    moved: number[] = [],
    p = [0, 0, 0];
  if (options.selection !== undefined) {
    if (typeof options.selection !== 'object' || options.selection === null || !(Symbol.iterator in options.selection))
      throw new TypeError('A layout selection is not iterable; pass cell indexes');
    for (const index of options.selection) {
      if (!Number.isInteger(index) || index < 0 || index >= cells)
        throw new RangeError(`Selection index ${index} is not a cell of the grid; pass indexes from 0 to ${cells - 1}`);
      selected.add(index);
    }
  }
  let clipped = 0;
  for (let y = 0, i = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++, i++) {
        const value = grid.voxels[i];
        if (!value && !selected.has(i)) continue;
        map(x, y, z, p);
        if (p[0] < 0 || p[1] < 0 || p[2] < 0 || p[0] >= rx || p[1] >= ry || p[2] >= rz) {
          if (value) clipped++;
          continue;
        }
        const next = p[0] + rx * (p[2] + rz * p[1]);
        voxels[next] = value;
        if (selected.has(i)) moved.push(next);
      }
  return { ...edited(grid, voxels, clipped, size), selection: Float64Array.from(moved), mapPoint };
}

function point(value: Vec3, subject: string): MutableVec3 {
  checkPoint(value, subject);
  return [value[0], value[1], value[2]];
}

/** Mirrors a grid along one principal axis, keeping its size: cell `c` on that axis moves to `size - 1 - c`. */
export function flipGrid(grid: VoxelGrid, options: FlipOptions): GridLayout {
  checkOptions(options, 'flipGrid');
  const axis = axisIndex(options.axis, 'flipGrid axis');
  checkGrid(grid, Number.MAX_SAFE_INTEGER);
  const n = grid.size[axis];
  return layout(
    grid,
    options,
    grid.size,
    (x, y, z, out) => {
      out[0] = x;
      out[1] = y;
      out[2] = z;
      out[axis] = n - 1 - out[axis];
    },
    (value) => {
      const p = point(value, 'flipGrid point');
      p[axis] = n - p[axis];
      return p;
    },
  );
}

/**
 * Turns a grid by right-handed quarter turns about one axis; the two other sizes swap with each odd turn, so nothing
 * is clipped. One turn about x maps cell (x, y, z) to (x, sz - 1 - z, y) in a grid of [sx, sz, sy]; about y,
 * (z, y, sx - 1 - x) in [sz, sy, sx]; about z, (sy - 1 - y, x, z) in [sy, sx, sz].
 */
export function turnGrid(grid: VoxelGrid, options: TurnOptions): GridLayout {
  checkOptions(options, 'turnGrid');
  const axis = axisIndex(options.axis, 'turnGrid axis'),
    turns = options.turns ?? 1;
  if (!Number.isSafeInteger(turns)) throw new RangeError('turnGrid turns is not a whole number; pass one');
  checkGrid(grid, Number.MAX_SAFE_INTEGER);
  const count = ((turns % 4) + 4) % 4,
    sizes: MutableVec3[] = [[grid.size[0], grid.size[1], grid.size[2]]];
  // One right-handed quarter turn of a cell (offset 1) or a corner point (offset 0) in a grid of size s.
  const once = (s: Vec3, p: number[], offset: number) => {
    const [x, y, z] = p;
    if (axis === 0) p.splice(0, 3, x, s[2] - offset - z, y);
    else if (axis === 1) p.splice(0, 3, z, y, s[0] - offset - x);
    else p.splice(0, 3, s[1] - offset - y, x, z);
  };
  for (let k = 0; k < count; k++) {
    const [a, b, c] = sizes[k];
    sizes.push(axis === 0 ? [a, c, b] : axis === 1 ? [c, b, a] : [b, a, c]);
  }
  return layout(
    grid,
    options,
    sizes[count],
    (x, y, z, out) => {
      out[0] = x;
      out[1] = y;
      out[2] = z;
      for (let k = 0; k < count; k++) once(sizes[k], out, 1);
    },
    (value) => {
      const p = point(value, 'turnGrid point');
      for (let k = 0; k < count; k++) once(sizes[k], p, 0);
      return p;
    },
  );
}

/** Moves every cell by a whole-cell offset inside the same box; filled cells leaving it are dropped and counted. */
export function shiftGrid(grid: VoxelGrid, options: ShiftOptions): GridLayout {
  checkOptions(options, 'shiftGrid');
  checkCell(options.offset, 'shiftGrid offset');
  checkGrid(grid, Number.MAX_SAFE_INTEGER);
  const [dx, dy, dz] = options.offset;
  return layout(
    grid,
    options,
    grid.size,
    (x, y, z, out) => {
      out[0] = x + dx;
      out[1] = y + dy;
      out[2] = z + dz;
    },
    (value) => {
      const p = point(value, 'shiftGrid point');
      return [p[0] + dx, p[1] + dy, p[2] + dz];
    },
  );
}

/** The box of filled cells, `max` exclusive, or null when the grid holds no filled cell. */
export function occupiedBounds(
  grid: VoxelGrid,
  limits: GridLimits = {},
): { min: MutableVec3; max: MutableVec3 } | null {
  checkOptions(limits, 'occupiedBounds');
  checkGrid(grid, cellLimit(limits));
  const [sx, sy, sz] = grid.size,
    min: MutableVec3 = [sx, sy, sz],
    max: MutableVec3 = [0, 0, 0];
  let any = false;
  for (let y = 0, i = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++, i++) {
        if (!grid.voxels[i]) continue;
        any = true;
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x >= max[0]) max[0] = x + 1;
        if (y >= max[1]) max[1] = y + 1;
        if (z >= max[2]) max[2] = z + 1;
      }
  return any ? { min, max } : null;
}

/**
 * Crops or extends a grid to `size` cells anchored at `origin`: input cell `origin + c` becomes result cell `c`, every
 * cell keeps its palette index, cells past the input are air and filled cells outside the new box are clipped. A
 * resize that keeps the lower corner is `origin` [0, 0, 0]; {@link fitGrid} shrinks to the filled cells.
 */
export function cropGrid(grid: VoxelGrid, options: CropOptions): GridLayout {
  checkOptions(options, 'cropGrid');
  checkCell(options.origin, 'cropGrid origin');
  const [ox, oy, oz] = options.origin;
  return layout(
    grid,
    options,
    options.size,
    (x, y, z, out) => {
      out[0] = x - ox;
      out[1] = y - oy;
      out[2] = z - oz;
    },
    (value) => {
      const p = point(value, 'cropGrid point');
      return [p[0] - ox, p[1] - oy, p[2] - oz];
    },
  );
}

/**
 * Shrinks a grid to the box of its filled cells ({@link occupiedBounds}); `origin` is that box's lower corner, the
 * input cell now at (0, 0, 0). An empty grid keeps its whole box, origin [0, 0, 0].
 */
export function fitGrid(grid: VoxelGrid, options: GridLayoutOptions = {}): GridLayout & { origin: MutableVec3 } {
  checkOptions(options, 'fitGrid');
  const bounds = occupiedBounds(grid, { maxCells: options.maxCells }),
    origin: MutableVec3 = bounds ? bounds.min : [0, 0, 0],
    size = bounds ? bounds.max.map((v, a) => v - origin[a]) : grid.size;
  return { ...cropGrid(grid, { ...options, origin, size: size as Vec3 }), origin };
}

/** Swaps filled and empty cells: filled cells become air and air takes `color`, in the same box. */
export function invertGrid(grid: VoxelGrid, options: InvertOptions): GridEdit {
  checkOptions(options, 'invertGrid');
  checkPalette(options.color, 'invertGrid color');
  const cells = checkGrid(grid, cellLimit(options)),
    voxels = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) voxels[i] = grid.voxels[i] ? 0 : options.color;
  return edited(grid, voxels, 0);
}
