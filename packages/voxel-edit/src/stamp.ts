// Stamping cell sets into dense or sparse grids: mirror-aware brush samples, one-operation stamps and clipboard paste
// with exact palette identity mapping (part of ./edit).
import type { Vec3 } from '@margoengine/math';
import {
  cellAt,
  cellLimit,
  checkCell,
  checkGrid,
  checkOptions,
  checkPalette,
  edited,
  type GridEdit,
  type GridLimits,
  MAX_CELLS,
  type VoxelGrid,
} from './grid.js';
import { type SparseEdit, SparseGrid, type VoxelEdit } from './sparse.js';

/** Options of {@link mirrorCells}. */
export interface MirrorOptions extends GridLimits {
  /** Size of the grid the samples land in; mirroring maps cell `c` to `size - 1 - c` on a mirrored axis. */
  size: Vec3;
  /** Whether to mirror across the centre plane of x, y and z. */
  mirror: readonly [boolean, boolean, boolean];
  /** Edge of the cubic brush stamped at each sample, 1 to 255: offsets `-floor((side - 1) / 2)` on. Default 1. */
  side?: number;
}

/** Mirror-expanded brush cells ({@link mirrorCells}). */
export interface MirrorStamp {
  /** Cell indexes inside the grid, each once, in stamping order (its first occurrence). */
  cells: Float64Array;
  /** Per cell, the index of the last sample that reached it; only when samples carry an index. */
  values?: Uint8Array;
}

/**
 * Expands brush samples through principal-axis mirrors: each sample `[x, y, z]` (or `[x, y, z, index]`) stamps a
 * cubic brush of `side` cells, and every brush cell is repeated at its mirror images, x outermost, then y, then z.
 * Cells outside the grid are dropped and a cell reached twice (a sample on a centre plane, overlapping brushes) is
 * kept once at its first position; with indexed samples the last sample reaching a cell sets its value.
 */
export function mirrorCells(samples: Iterable<readonly number[]>, options: MirrorOptions): MirrorStamp {
  checkOptions(options, 'mirrorCells');
  checkCell(options.size, 'mirrorCells size');
  const [sx, sy, sz] = options.size,
    mirror = options.mirror,
    side = options.side ?? 1,
    limit = cellLimit(options);
  if (sx < 1 || sy < 1 || sz < 1) throw new RangeError('mirrorCells size has an empty axis; pass sizes of at least 1');
  if (!Array.isArray(mirror) || mirror.length !== 3 || !mirror.every((v) => typeof v === 'boolean'))
    throw new TypeError('mirrorCells mirror is not three booleans; pass [x, y, z]');
  if (!Number.isInteger(side) || side < 1 || side > 255)
    throw new RangeError('mirrorCells side must be an integer from 1 to 255; pass one');
  const low = -Math.floor((side - 1) / 2),
    order = new Map<number, number>();
  let indexed: boolean | undefined;
  for (const sample of samples) {
    if (!Array.isArray(sample) || (sample.length !== 3 && sample.length !== 4))
      throw new TypeError('mirrorCells sample is not [x, y, z] or [x, y, z, index]; pass one');
    if (indexed === undefined) indexed = sample.length === 4;
    else if (indexed !== (sample.length === 4))
      throw new TypeError('mirrorCells samples mix [x, y, z] and [x, y, z, index]; pass one kind');
    checkCell(sample.slice(0, 3), 'mirrorCells sample');
    if (indexed) checkPalette(sample[3], 'mirrorCells sample index', 0);
    const [cx, cy, cz] = sample,
      value = indexed ? sample[3] : 0;
    for (let dy = low; dy < low + side; dy++)
      for (let dz = low; dz < low + side; dz++)
        for (let dx = low; dx < low + side; dx++) {
          const x = cx + dx,
            y = cy + dy,
            z = cz + dz,
            xs = mirror[0] ? [x, sx - 1 - x] : [x],
            ys = mirror[1] ? [y, sy - 1 - y] : [y],
            zs = mirror[2] ? [z, sz - 1 - z] : [z];
          for (const px of xs)
            for (const py of ys)
              for (const pz of zs) {
                if (px < 0 || py < 0 || pz < 0 || px >= sx || py >= sy || pz >= sz) continue;
                const index = px + sx * (pz + sz * py);
                if (!order.has(index) && order.size >= limit)
                  throw new RangeError(`mirrorCells covers over ${limit} cells; stamp less or raise maxCells`);
                order.set(index, value);
              }
        }
  }
  return indexed
    ? { cells: Float64Array.from(order.keys()), values: Uint8Array.from(order.values()) }
    : { cells: Float64Array.from(order.keys()) };
}

/** Options of {@link stampCells}. */
export interface StampOptions {
  /** `'fill'` writes every cell, `'paint'` only filled ones, `'erase'` empties them. */
  operation: 'fill' | 'paint' | 'erase';
  /** Palette index written by fill and paint, 1-255; without it fill and paint write `values`. */
  color?: number;
  /** Per cell of the stamp, the index fill or paint writes (a {@link MirrorStamp}'s values); 0 empties the cell. */
  values?: Uint8Array;
  /** When given, only cells listed here (cell indexes) change. */
  selection?: { has(index: number): boolean };
}

function stampPlan(size: Vec3, cells: ArrayLike<number>, options: StampOptions, read: (index: number) => number) {
  checkOptions(options, 'stampCells');
  const { operation, color, values, selection } = options;
  if (operation !== 'fill' && operation !== 'paint' && operation !== 'erase')
    throw new TypeError("stampCells operation is unknown; pass 'fill', 'paint' or 'erase'");
  if (color !== undefined) checkPalette(color, 'stampCells color');
  if (values !== undefined && (!(values instanceof Uint8Array) || values.length !== cells.length))
    throw new RangeError('stampCells values must be a Uint8Array with one index per cell; pass mirrorCells values');
  if (operation !== 'erase' && color === undefined && values === undefined)
    throw new TypeError(`stampCells ${operation} needs a color or values; pass one`);
  if (selection !== undefined && typeof selection?.has !== 'function')
    throw new TypeError('stampCells selection has no has(index); pass a Set of cell indexes');
  const total = size[0] * size[1] * size[2],
    writes = new Map<number, number>();
  for (let i = 0; i < cells.length; i++) {
    const index = cells[i];
    if (!Number.isSafeInteger(index) || index < 0 || index >= total)
      throw new RangeError(`stampCells cell ${index} is not a cell index of the grid; pass indexes from mirrorCells`);
    if (selection && !selection.has(index)) continue;
    const before = writes.get(index) ?? read(index);
    if (operation === 'paint' && !read(index)) continue;
    const value = operation === 'erase' ? 0 : (color ?? values![i]);
    if (value !== before) writes.set(index, value);
  }
  return writes;
}

/** Writes a stamp into a dense grid as one edit; the input grid is unchanged. */
export function stampCells(target: VoxelGrid, cells: ArrayLike<number>, options: StampOptions): GridEdit;
/** Writes a stamp into a sparse grid as one undoable edit; nothing is kept when a check fails. */
export function stampCells(target: SparseGrid, cells: ArrayLike<number>, options: StampOptions): SparseEdit;
/**
 * Writes a stamp (cell indexes, such as {@link mirrorCells} gives) into a grid as one edit: fill, paint (filled cells
 * only, judged before the stamp) or erase, with one color or per-cell values (the last value for a cell listed twice
 * wins), limited to `selection` when given.
 */
export function stampCells(
  target: VoxelGrid | SparseGrid,
  cells: ArrayLike<number>,
  options: StampOptions,
): GridEdit | SparseEdit {
  if (target instanceof SparseGrid) {
    const writes = stampPlan(target.size, cells, options, (index) => target.get(...cellAt(target.size, index)));
    return target.edit([...writes].map(([index, value]) => [...cellAt(target.size, index), value] as VoxelEdit));
  }
  checkGrid(target, MAX_CELLS, 'stampCells target');
  const writes = stampPlan(target.size, cells, options, (index) => target.voxels[index]),
    voxels = target.voxels.slice();
  for (const [index, value] of writes) voxels[index] = value;
  return edited(target, voxels, 0);
}

/** Options of {@link pasteCells}. */
export interface PasteOptions extends GridLimits {
  /** Where clip cell (0, 0, 0) lands in the target, in whole cells. */
  offset: Vec3;
  /** 256 identity strings of the target's palette slots (colour plus material, say); equal strings mean equal slots. */
  targetKeys: readonly string[];
  /** 256 identity strings of the clip's palette slots. */
  clipKeys: readonly string[];
}

/** A paste that fit ({@link pasteCells}); the grid fields come from the dense or sparse edit. */
export interface PastePlan {
  status: 'pasted';
  /** Target palette index of each clip index the paste used; 0 elsewhere. */
  paletteMap: Uint8Array;
  /** Clip indexes given a new target slot, in first-use order: copy the clip's palette and material entry there. */
  assignments: { from: number; to: number }[];
  /** Target cell indexes written, each once, in clip order: the pasted selection. */
  selection: Float64Array;
  /** Clip cells that fell outside the target. */
  clipped: number;
}

/** A paste refused because the target palette is full; nothing changed. */
export interface PasteOverflow {
  status: 'overflow';
  /** Clip identities the target has no slot for. */
  needed: number;
  /** Target slots that were free for them. */
  free: number;
}

/**
 * Pastes clip cells `[x, y, z, index]` (index 1-255, clip palette) into a dense grid at `offset`, as one edit or not
 * at all. See the sparse overload for the palette rules.
 */
export function pasteCells(
  target: VoxelGrid,
  clip: Iterable<readonly number[]>,
  options: PasteOptions,
): (PastePlan & GridEdit) | PasteOverflow;
/**
 * Pastes clip cells into a sparse grid as one undoable edit, or not at all. Each clip index used keeps its own target
 * slot when that slot already has the same identity, else takes the first target slot (1-255) with that identity,
 * else the lowest slot no remaining target cell or earlier mapping uses (its entry must then be copied, see
 * `assignments`). Equal-looking slots therefore stay distinct where the saved slot numbers match. When the target
 * has no slot left the result is `'overflow'` and nothing changes; colours are never approximated.
 */
export function pasteCells(
  target: SparseGrid,
  clip: Iterable<readonly number[]>,
  options: PasteOptions,
): (PastePlan & SparseEdit) | PasteOverflow;
export function pasteCells(
  target: VoxelGrid | SparseGrid,
  clip: Iterable<readonly number[]>,
  options: PasteOptions,
): (PastePlan & (GridEdit | SparseEdit)) | PasteOverflow {
  checkOptions(options, 'pasteCells');
  const limit = cellLimit(options),
    sparse = target instanceof SparseGrid;
  if (!sparse) checkGrid(target, MAX_CELLS, 'pasteCells target');
  checkCell(options.offset, 'pasteCells offset');
  for (const keys of [options.targetKeys, options.clipKeys])
    if (!Array.isArray(keys) || keys.length !== 256 || keys.some((key) => typeof key !== 'string'))
      throw new TypeError('pasteCells keys must be 256 strings per palette; pass targetKeys and clipKeys');
  const [sx, sy, sz] = target.size,
    [ox, oy, oz] = options.offset,
    placed: [index: number, value: number][] = [];
  let count = 0,
    clipped = 0;
  for (const cell of clip) {
    if (++count > limit) throw new RangeError(`pasteCells clip holds over ${limit} cells; raise maxCells`);
    if (!Array.isArray(cell) || cell.length !== 4) throw new TypeError('pasteCells clip cell is not [x, y, z, index]');
    checkCell(cell.slice(0, 3), 'pasteCells clip cell');
    checkPalette(cell[3], 'pasteCells clip index');
    const x = cell[0] + ox,
      y = cell[1] + oy,
      z = cell[2] + oz;
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) clipped++;
    else placed.push([x + sx * (z + sz * y), cell[3]]);
  }
  const destinations = new Set(placed.map(([index]) => index)),
    used = new Set<number>();
  if (sparse) {
    for (const [x, y, z, value] of target.filled()) if (!destinations.has(x + sx * (z + sz * y))) used.add(value);
  } else
    for (let i = 0; i < target.voxels.length; i++)
      if (target.voxels[i] && !destinations.has(i)) used.add(target.voxels[i]);
  const identities = [...options.targetKeys],
    paletteMap = new Uint8Array(256),
    assignments: { from: number; to: number }[] = [];
  let needed = 0,
    free = 0;
  for (const source of new Set(placed.map(([, value]) => value))) {
    const identity = options.clipKeys[source];
    let index =
      identities[source] === identity ? source : identities.findIndex((key, slot) => slot > 0 && key === identity);
    if (index < 1) {
      needed++;
      index = 1;
      while (index < 256 && used.has(index)) index++;
      if (index === 256) continue;
      free++;
      identities[index] = identity;
      assignments.push({ from: source, to: index });
    }
    used.add(index);
    paletteMap[source] = index;
  }
  if (needed > free) return { status: 'overflow', needed, free };
  const plan = {
    status: 'pasted' as const,
    paletteMap,
    assignments,
    selection: Float64Array.from(destinations),
    clipped,
  };
  if (sparse)
    return {
      ...plan,
      ...target.edit(placed.map(([index, value]) => [...cellAt(target.size, index), paletteMap[value]] as VoxelEdit)),
    };
  const voxels = target.voxels.slice();
  for (const [index, value] of placed) voxels[index] = paletteMap[value];
  return { ...plan, ...edited(target, voxels, clipped) };
}
