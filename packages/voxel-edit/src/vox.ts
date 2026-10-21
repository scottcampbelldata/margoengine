// .vox interop: MagicaVoxel's Z-up models to and from Y-up grids, and editing of .vox scene graphs (vox-scene.ts).
import type { MutableVec3 } from '@margoengine/math';
import type { VoxModel } from '@margoengine/voxel/vox';
import {
  cellLimit,
  checkGrid,
  checkOptions,
  DEFAULT_CELLS,
  type GridLimits,
  MAX_CELLS,
  type VoxelGrid,
} from './grid.js';
import { type GridWindow, SparseGrid } from './sparse.js';

export * from './vox-scene.js';

function voxSize(size: unknown, limits: GridLimits, subject: string): MutableVec3 {
  if (!Array.isArray(size) || size.length !== 3) throw new TypeError(`${subject} is not [x, y, z]; pass three sizes`);
  if (!size.every((v) => Number.isInteger(v) && v >= 1 && v <= 256))
    throw new RangeError(`${subject} must be 1 to 256 cells per axis, the .vox limit; resize the model`);
  const cells = size[0] * size[1] * size[2],
    limit = cellLimit(limits, DEFAULT_CELLS);
  if (cells > limit) throw new RangeError(`${subject} exceeds maxCells (${limit}); raise maxCells`);
  return [size[0], size[1], size[2]];
}

/**
 * A grid from a .vox model (`parseVox(bytes).models[i]`), turned from MagicaVoxel's Z up to Y up: .vox cell
 * (x, y, z) becomes grid cell (x, z, sizeY - 1 - y). When a cell is listed twice the later entry wins.
 */
export function gridFromVox(model: VoxModel, limits: GridLimits = {}): VoxelGrid {
  if (typeof model !== 'object' || model === null) throw new TypeError('gridFromVox model is missing; pass a VoxModel');
  const [vx, vy, vz] = voxSize(model.size, limits, 'gridFromVox size'),
    records = model.voxels;
  if (!(records instanceof Uint8Array) || records.length % 4)
    throw new RangeError('gridFromVox voxels are not x, y, z, index records; pass a Uint8Array of 4-byte records');
  for (let i = 0; i < records.length; i += 4) {
    if (records[i] >= vx || records[i + 1] >= vy || records[i + 2] >= vz)
      throw new RangeError(`gridFromVox record ${i / 4} lies outside the model size; fix the record or the size`);
    if (!records[i + 3]) throw new RangeError(`gridFromVox record ${i / 4} has palette index 0; use 1 to 255`);
  }
  const size: MutableVec3 = [vx, vz, vy],
    voxels = new Uint8Array(vx * vy * vz);
  for (let i = 0; i < records.length; i += 4)
    voxels[records[i] + vx * (vy - 1 - records[i + 1] + vy * records[i + 2])] = records[i + 3];
  return { size, voxels };
}

/**
 * A .vox model from a dense or sparse grid (each axis 1 to 256), the inverse turn of {@link gridFromVox}. When
 * `original` holds the same cells it is returned as it is, so an unedited model keeps its record order and duplicates.
 */
export function voxFromGrid(source: VoxelGrid | SparseGrid, original?: VoxModel, limits: GridLimits = {}): VoxModel {
  const sparse = source instanceof SparseGrid,
    [sx, sy, sz] = voxSize(source?.size, limits, 'voxFromGrid size');
  if (!sparse) checkGrid(source, sx * sy * sz);
  const read = sparse
    ? (x: number, y: number, z: number) => source.get(x, y, z)
    : (x: number, y: number, z: number) => source.voxels[x + sx * (z + sz * y)];
  if (original && original.size[0] === sx && original.size[1] === sz && original.size[2] === sy) {
    const before = gridFromVox(original, limits).voxels;
    let same = true;
    for (let y = 0, i = 0; same && y < sy; y++)
      for (let z = 0; same && z < sz; z++)
        for (let x = 0; x < sx; x++, i++) if (before[i] !== read(x, y, z)) same = false;
    if (same) return original;
  }
  const records: number[] = [];
  if (sparse) for (const [x, y, z, value] of source.filled()) records.push(x, sz - 1 - z, y, value);
  else
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++) {
          const value = source.voxels[x + sx * (z + sz * y)];
          if (value) records.push(x, sz - 1 - z, y, value);
        }
  return { size: [sx, sz, sy], voxels: Uint8Array.from(records) };
}

/** Options of {@link voxTiles}. */
export interface VoxTileOptions extends GridLimits {
  /** Tile edge in cells, 1 to 256 (the .vox limit). Default 256. */
  tileSize?: number;
  /** Most tiles, 1 to 65,536. Default 4,096. */
  maxTiles?: number;
}

/**
 * Splits a dense or sparse grid into `.vox`-sized models: the filled cells of each `tileSize`-cell box (boxes aligned
 * at cell 0) cropped to their own bounds, sorted by lower corner (y, then z, then x). Each tile is a Y-up window
 * whose `origin` is its exact offset in `source` cells; no axis is turned, so `voxFromGrid(tile)` gives the model and
 * the caller places it. Empty boxes give no tile; an empty grid gives none. A sparse grid is read through its filled
 * cells only. Counts are checked before any tile is allocated: `maxTiles` tiles and `maxCells` cells in all.
 */
export function voxTiles(source: VoxelGrid | SparseGrid, options: VoxTileOptions = {}): GridWindow[] {
  checkOptions(options, 'voxTiles');
  const tile = options.tileSize ?? 256,
    maxTiles = options.maxTiles ?? 4096,
    limit = cellLimit(options);
  if (!Number.isInteger(tile) || tile < 1 || tile > 256)
    throw new RangeError('voxTiles tileSize must be an integer from 1 to 256; pass one');
  if (!Number.isInteger(maxTiles) || maxTiles < 1 || maxTiles > 65_536)
    throw new RangeError('voxTiles maxTiles must be an integer from 1 to 65,536; pass one');
  const sparse = source instanceof SparseGrid;
  if (!sparse) checkGrid(source, MAX_CELLS, 'voxTiles grid');
  const [sx, , sz] = source.size,
    filled = sparse
      ? () => source.filled()
      : function* (): IterableIterator<readonly [number, number, number, number]> {
          const voxels = source.voxels;
          for (let i = 0; i < voxels.length; i++)
            if (voxels[i]) {
              const row = Math.floor(i / sx);
              yield [i - row * sx, Math.floor(row / sz), row % sz, voxels[i]];
            }
        },
    boxes = new Map<string, { min: MutableVec3; max: MutableVec3 }>(),
    key = (x: number, y: number, z: number) =>
      `${Math.floor(x / tile)},${Math.floor(y / tile)},${Math.floor(z / tile)}`;
  for (const [x, y, z] of filled()) {
    const address = key(x, y, z);
    let box = boxes.get(address);
    if (!box) {
      if (boxes.size >= maxTiles)
        throw new RangeError(`voxTiles needs over ${maxTiles} tiles; raise maxTiles or split the grid`);
      boxes.set(address, (box = { min: [x, y, z], max: [x + 1, y + 1, z + 1] }));
    }
    const cell = [x, y, z];
    for (let a = 0; a < 3; a++) {
      if (cell[a] < box.min[a]) box.min[a] = cell[a];
      if (cell[a] >= box.max[a]) box.max[a] = cell[a] + 1;
    }
  }
  const sorted = [...boxes.entries()].sort(
      ([, a], [, b]) => a.min[1] - b.min[1] || a.min[2] - b.min[2] || a.min[0] - b.min[0],
    ),
    sizes = sorted.map(([, box]) => box.max.map((v, a) => v - box.min[a]) as MutableVec3);
  let total = 0;
  for (const [w, h, d] of sizes) {
    total += w * h * d;
    if (total > limit)
      throw new RangeError(`voxTiles tiles hold over ${limit} cells; raise maxCells or split the grid`);
  }
  const tiles: GridWindow[] = sorted.map(([, box], i) => ({
      origin: box.min,
      size: sizes[i],
      voxels: new Uint8Array(sizes[i][0] * sizes[i][1] * sizes[i][2]),
    })),
    byKey = new Map(sorted.map(([address], i) => [address, tiles[i]]));
  for (const [x, y, z, value] of filled()) {
    const { origin, size, voxels } = byKey.get(key(x, y, z))!;
    voxels[x - origin[0] + size[0] * (z - origin[2] + size[2] * (y - origin[1]))] = value;
  }
  return tiles;
}
