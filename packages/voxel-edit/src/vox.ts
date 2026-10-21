// .vox interop: MagicaVoxel's Z-up models to and from Y-up grids, and editing of .vox scene graphs (vox-scene.ts).
import type { MutableVec3 } from '@margoengine/math';
import type { VoxModel } from '@margoengine/voxel/vox';
import { cellLimit, checkGrid, DEFAULT_CELLS, type GridLimits, type VoxelGrid } from './grid.js';
import { SparseGrid } from './sparse.js';

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
