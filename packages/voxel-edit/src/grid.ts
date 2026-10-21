// Dense voxel grids: the shape every voxel-edit operation reads and returns, cell indexing and the shared cell budget.
import type { MutableVec3, Vec3 } from '@margoengine/math';

/**
 * A dense voxel model: one palette index per cell, 0 for air and 1 to 255 for filled cells, Y up. Cell (x, y, z) is
 * `voxels[x + size[0] * (z + size[2] * y)]`, the layout {@link cellIndex} computes. Operations never change a grid
 * they are given; they return a new one.
 */
export interface VoxelGrid {
  /** Cells along x, y and z, each a positive integer. */
  readonly size: Vec3;
  /** Palette indexes, `size[0] * size[1] * size[2]` of them. */
  readonly voxels: Uint8Array;
}

/** The cell budget of an operation, checked before it allocates anything. */
export interface GridLimits {
  /** Most cells the operation may allocate or visit, 1 to 67,108,864. Default 16,777,216 (256 x 256 x 256). */
  maxCells?: number;
}

/** What a grid operation returns: a new grid and what changed. */
export interface GridEdit {
  /** The result, with its own `voxels` and `size`. */
  grid: VoxelGrid;
  /** Cells whose palette index differs between input and result; cells outside either grid read as air. */
  changed: number;
  /** Filled cells the operation moved or copied out of the result's bounds and so dropped. */
  clipped: number;
}

/** A ray hit on a grid, in local cells. */
export interface GridHit {
  /** The filled cell hit. */
  cell: MutableVec3;
  /** The cell in front of the face hit, `cell + normal`: where a new voxel goes. */
  adjacent: MutableVec3;
  /** Outward normal of the face the ray entered through; [0, 0, 0] when the ray starts inside the cell. */
  normal: MutableVec3;
  /** The cell's palette index, 1-255. */
  value: number;
  /** Distance along the normalized ray to the face hit (0 when starting inside). */
  distance: number;
}

/** @internal Default and hard ceiling of {@link GridLimits.maxCells}. */
export const DEFAULT_CELLS = 16_777_216,
  MAX_CELLS = 67_108_864;

/** Index of cell (x, y, z) in a grid of `size`: `x + size[0] * (z + size[2] * y)`. */
export function cellIndex(size: Vec3, x: number, y: number, z: number): number {
  return x + size[0] * (z + size[2] * y);
}

/** The cell at `index` in a grid of `size`, the inverse of {@link cellIndex}. */
export function cellAt(size: Vec3, index: number): MutableVec3 {
  const row = Math.floor(index / size[0]);
  return [index - row * size[0], Math.floor(row / size[2]), row % size[2]];
}

/** Whether (x, y, z) is an integer cell inside a grid of `size`. */
export function insideGrid(size: Vec3, x: number, y: number, z: number): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    Number.isInteger(z) &&
    x >= 0 &&
    y >= 0 &&
    z >= 0 &&
    x < size[0] &&
    y < size[1] &&
    z < size[2]
  );
}

/** @internal Throws unless `options` is an object. */
export function checkOptions(options: unknown, subject: string): asserts options is object {
  if (typeof options !== 'object' || options === null)
    throw new TypeError(`${subject} options are missing; pass an options object`);
}

/** @internal The validated `maxCells` of `options`. */
export function cellLimit(options: GridLimits, fallback = DEFAULT_CELLS): number {
  const value = options.maxCells ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CELLS)
    throw new RangeError(`maxCells is out of range; pass an integer from 1 to ${MAX_CELLS}`);
  return value;
}

/** @internal Throws unless `value` holds three safe integers. */
export function checkCell(value: unknown, subject: string): asserts value is Vec3 {
  if (!Array.isArray(value) || value.length !== 3)
    throw new TypeError(`${subject} is not [x, y, z]; pass three numbers`);
  // Index each entry: every() would skip the holes of a sparse array.
  if (!Number.isSafeInteger(value[0]) || !Number.isSafeInteger(value[1]) || !Number.isSafeInteger(value[2]))
    throw new RangeError(`${subject} is not whole cells; pass three integers`);
}

/** @internal Throws unless `value` holds three finite numbers. */
export function checkPoint(value: unknown, subject: string): asserts value is Vec3 {
  if (!Array.isArray(value) || value.length !== 3)
    throw new TypeError(`${subject} is not [x, y, z]; pass three numbers`);
  if (!Number.isFinite(value[0]) || !Number.isFinite(value[1]) || !Number.isFinite(value[2]))
    throw new RangeError(`${subject} is not finite; pass three finite numbers`);
}

/** @internal The cell count of a grid of `size`, checked against `limit` before anything is allocated. */
export function sizeCells(size: unknown, limit: number, subject = 'Grid size'): number {
  checkCell(size, subject);
  if (size.some((v) => v < 1)) throw new RangeError(`${subject} has an empty axis; pass sizes of at least 1`);
  const cells = size[0] * size[1] * size[2];
  if (!Number.isSafeInteger(cells) || cells > limit)
    throw new RangeError(`${subject} exceeds maxCells (${limit}); make it smaller or raise maxCells`);
  return cells;
}

/** @internal Checks a grid's size against `limit` and its buffer against its size; returns its cell count. */
export function checkGrid(grid: VoxelGrid, limit: number, subject = 'Grid'): number {
  if (typeof grid !== 'object' || grid === null) throw new TypeError(`${subject} is missing; pass {size, voxels}`);
  const cells = sizeCells(grid.size, limit, `${subject} size`);
  if (!(grid.voxels instanceof Uint8Array)) throw new TypeError(`${subject} voxels are not a Uint8Array; pass one`);
  if (grid.voxels.length !== cells)
    throw new RangeError(`${subject} voxels hold ${grid.voxels.length} cells, not ${cells}; match the size`);
  return cells;
}

/** @internal Throws unless `value` is a palette index from `min` (0 or 1) to 255. */
export function checkPalette(value: unknown, subject: string, min: 0 | 1 = 1): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > 255)
    throw new RangeError(`${subject} is not a palette index; pass an integer from ${min} to 255`);
}

/** @internal 0, 1 or 2 for 'x', 'y' or 'z'. */
export function axisIndex(axis: unknown, subject: string): 0 | 1 | 2 {
  const index = ['x', 'y', 'z'].indexOf(axis as string);
  if (index < 0) throw new TypeError(`${subject} is not an axis; pass 'x', 'y' or 'z'`);
  return index as 0 | 1 | 2;
}

/** @internal A result grid of `size` (default the source's) and its counts against `source`. */
export function edited(source: VoxelGrid, voxels: Uint8Array, clipped: number, size: Vec3 = source.size): GridEdit {
  const grid: VoxelGrid = { size: [size[0], size[1], size[2]], voxels };
  return { grid, changed: changedCells(source, grid), clipped };
}

/** Cells whose index differs between `a` and `b`, reading cells outside either grid as air. */
function changedCells(a: VoxelGrid, b: VoxelGrid): number {
  const [ax, ay, az] = a.size,
    [bx, by, bz] = b.size;
  let changed = 0;
  if (ax === bx && ay === by && az === bz) {
    for (let i = 0; i < a.voxels.length; i++) if (a.voxels[i] !== b.voxels[i]) changed++;
    return changed;
  }
  for (let y = 0; y < ay; y++)
    for (let z = 0; z < az; z++)
      for (let x = 0; x < ax; x++) {
        const other = x < bx && y < by && z < bz ? b.voxels[x + bx * (z + bz * y)] : 0;
        if (a.voxels[x + ax * (z + az * y)] !== other) changed++;
      }
  for (let y = 0; y < by; y++)
    for (let z = 0; z < bz; z++)
      for (let x = 0; x < bx; x++) if ((x >= ax || y >= ay || z >= az) && b.voxels[x + bx * (z + bz * y)]) changed++;
  return changed;
}
