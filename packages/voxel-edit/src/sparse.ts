// Sparse grids: huge, mostly empty models stored as @margoengine/voxel chunks, edited by copy-on-write snapshots.
import type { MutableVec3, Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { VoxelChunk, type VoxelWorld } from '@margoengine/voxel';
import { checkCell, checkPalette, checkPoint, type GridHit, type VoxelGrid } from './grid.js';

/** One cell change: local x, y, z and the new palette index (0 empties the cell). */
export type VoxelEdit = readonly [x: number, y: number, z: number, index: number];

/** Memory and work budgets of a sparse grid, checked before an edit is kept. Each may be raised to 4x its default. */
export interface SparseLimits {
  /** Chunks (32 x 32 x 32 cells each) the grid may hold. Default 4,096. */
  maxChunks?: number;
  /** Bytes of chunk storage. Default 134,217,728 (128 MiB). */
  maxBytes?: number;
  /** Cell edits in one `edit` call. Default 1,048,576. */
  maxEdits?: number;
  /** Cells in one dense window (`readWindow`, `fromGrid`) or traversal. Default 16,777,216. */
  maxWindowCells?: number;
}

/** Options of {@link SparseGrid.empty}. */
export interface SparseOptions extends SparseLimits {
  /** Engine cell of local cell (0, 0, 0), for {@link SparseGrid.toWorld}. Y must stay within -32768 to 32767. Default [0, 0, 0]. */
  origin?: Vec3;
}

/** A dense copy of part of a sparse grid. */
export interface GridWindow extends VoxelGrid {
  /** Local cell of the window's (0, 0, 0). */
  readonly origin: Vec3;
}

/** An undo token from {@link SparseGrid.edit}; pass it to {@link SparseGrid.restore}. */
export interface SparseDelta {
  /** Cells the edit changed. */
  readonly changed: number;
  /** Chunk bytes the before and after snapshots of the touched chunks hold. */
  readonly bytes: number;
}

/** What a sparse edit returns. An edit that changes nothing returns the same grid. */
export interface SparseEdit {
  /** The new snapshot; the old one is unchanged and shares every untouched chunk. */
  grid: SparseGrid;
  /** Undo token. */
  delta: SparseDelta;
}

/** Statistics of a sparse grid. */
export interface SparseStats {
  /** Filled cells. */
  filled: number;
  /** Chunks held (empty chunks are dropped). */
  chunks: number;
  /** Bytes of chunk storage. */
  bytes: number;
}

/**
 * The saved form of a sparse grid ({@link SparseGrid.serialize}): plain JSON. `format` and `version` stay
 * `'margo-sparse-volume'` and 1 so files written before the rename still load.
 */
export interface SparseGridData {
  format: 'margo-sparse-volume';
  version: 1;
  size: MutableVec3;
  origin: MutableVec3;
  /** Packed chunks in @margoengine/voxel's palette layout. */
  chunks: { position: MutableVec3; palette: number[]; bits: 0 | 1 | 2 | 4 | 8; words: number[] }[];
}

type Entry = { position: MutableVec3; chunk: VoxelChunk; filled: number };
type Limits = Required<SparseLimits>;
const DEFAULTS: Limits = { maxChunks: 4096, maxBytes: 134_217_728, maxEdits: 1_048_576, maxWindowCells: 16_777_216 };
const history = new WeakMap<SparseDelta, { before: SparseGrid; after: SparseGrid }>();
const chunkKey = (x: number, y: number, z: number) => `${x},${y},${z}`;
// Local cells may pass 2^31 on x and z, so no bit shifts.
const chunkOf = (v: number) => Math.floor(v / 32);
const tuple = (v: Vec3): MutableVec3 => [v[0], v[1], v[2]];
const SIX = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
] as const;

/**
 * An immutable sparse voxel grid for models far larger than memory would hold densely: only chunks with filled cells
 * exist, so a 1,000,000-wide grid with two filled cells holds two chunks. Each edit returns a new snapshot that copies
 * only the chunks it touched. Palette indexes and the cell layout are those of {@link VoxelGrid}.
 */
export class SparseGrid {
  /** Cells along x, y and z. */
  readonly size: Vec3;
  /** Engine cell of local (0, 0, 0). */
  readonly origin: Vec3;
  readonly #limits: Limits;
  readonly #chunks: ReadonlyMap<string, Entry>;

  private constructor(size: Vec3, origin: Vec3, limits: Limits, chunks: ReadonlyMap<string, Entry>) {
    this.size = Object.freeze(tuple(size));
    this.origin = Object.freeze(tuple(origin));
    this.#limits = limits;
    this.#chunks = chunks;
    Object.freeze(this);
  }

  /** An empty grid of `size`; allocates no chunks, however large. */
  static empty(size: Vec3, options: SparseOptions = {}): SparseGrid {
    const limits = checkLimits(options),
      origin = options.origin ?? [0, 0, 0];
    checkExtent(size, origin);
    return new SparseGrid(size, origin, limits, new Map());
  }

  /** A sparse copy of a dense grid (at most `maxWindowCells` cells); palette indexes are kept exactly. */
  static fromGrid(grid: VoxelGrid, options: SparseOptions = {}): SparseGrid {
    const empty = SparseGrid.empty(grid?.size, options),
      [sx, sy, sz] = grid.size,
      cells = sx * sy * sz;
    if (cells > empty.#limits.maxWindowCells)
      throw new RangeError('SparseGrid.fromGrid source exceeds maxWindowCells; convert it in windows instead');
    if (!(grid.voxels instanceof Uint8Array) || grid.voxels.length !== cells)
      throw new RangeError(`SparseGrid.fromGrid voxels do not hold ${cells} cells; match the size`);
    const chunks = new Map<string, Entry>();
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++) {
          const value = grid.voxels[x + sx * (z + sz * y)];
          if (!value) continue;
          const position: MutableVec3 = [chunkOf(x), chunkOf(y), chunkOf(z)],
            address = chunkKey(...position);
          let entry = chunks.get(address);
          if (!entry) {
            if (chunks.size >= empty.#limits.maxChunks)
              throw new RangeError('SparseGrid.fromGrid exceeds maxChunks; raise it or convert less');
            entry = { position, chunk: new VoxelChunk(), filled: 0 };
            chunks.set(address, entry);
          }
          entry.chunk.set(x % 32, y % 32, z % 32, value);
          entry.filled++;
        }
    checkStorage(chunks, empty.#limits);
    return new SparseGrid(empty.size, empty.origin, empty.#limits, chunks);
  }

  /** Decodes {@link SparseGridData} (untrusted input is fine: every count, word and index is checked first). */
  static deserialize(data: unknown, limits: SparseLimits = {}): SparseGrid {
    if (typeof data !== 'object' || data === null)
      throw new TypeError('SparseGrid data is missing; pass the object serialize() returned');
    const value = data as SparseGridData;
    if (value.format !== 'margo-sparse-volume' || value.version !== 1)
      throw new RangeError("SparseGrid data has an unknown format; expect 'margo-sparse-volume' version 1");
    const empty = SparseGrid.empty(value.size, { ...limits, origin: value.origin }),
      checked = empty.#limits;
    if (!Array.isArray(value.chunks) || value.chunks.length > checked.maxChunks)
      throw new RangeError('SparseGrid data exceeds maxChunks; raise it or load a smaller grid');
    const seen = new Set<string>();
    let bytes = 0;
    for (const item of value.chunks) {
      if (typeof item !== 'object' || item === null)
        throw new TypeError('SparseGrid chunk is not an object; pass packed chunks');
      checkCell(item.position, 'SparseGrid chunk position');
      if (item.position.some((p, axis) => p < 0 || p * 32 >= value.size[axis]))
        throw new RangeError('SparseGrid chunk lies outside the grid bounds; drop it');
      const address = chunkKey(...item.position);
      if (seen.has(address)) throw new RangeError('SparseGrid data has a duplicate chunk; keep one per position');
      seen.add(address);
      if (
        ![0, 1, 2, 4, 8].includes(item.bits) ||
        !Array.isArray(item.palette) ||
        item.palette.length < 1 ||
        item.palette.length > Math.min(256, 2 ** item.bits) ||
        !Array.isArray(item.words) ||
        item.words.length !== 1024 * item.bits
      )
        throw new RangeError('SparseGrid chunk palette or word length is wrong; use the packed chunk layout');
      for (const index of item.palette) checkPalette(index, 'SparseGrid chunk palette entry', 0);
      for (const word of item.words)
        if (!Number.isInteger(word) || word < 0 || word > 0xffffffff)
          throw new RangeError('SparseGrid chunk word is not an unsigned 32-bit integer; fix the data');
      bytes += 4 * (item.palette.length + item.words.length);
      if (bytes > checked.maxBytes) throw new RangeError('SparseGrid data exceeds maxBytes; raise it or load less');
    }
    const chunks = new Map<string, Entry>();
    for (const item of value.chunks) {
      const chunk = VoxelChunk.unpack({
          palette: Uint32Array.from(item.palette),
          bits: item.bits,
          words: Uint32Array.from(item.words),
          light: 0,
        }),
        [cx, cy, cz] = item.position;
      let filled = 0;
      for (let y = 0; y < 32; y++)
        for (let z = 0; z < 32; z++)
          for (let x = 0; x < 32; x++)
            if (chunk.get(x, y, z)) {
              if (cx * 32 + x >= value.size[0] || cy * 32 + y >= value.size[1] || cz * 32 + z >= value.size[2])
                throw new RangeError('SparseGrid chunk fills a cell outside the grid bounds; empty it');
              filled++;
            }
      if (!filled) throw new RangeError('SparseGrid chunk is empty; leave empty chunks out');
      chunks.set(chunkKey(cx, cy, cz), { position: tuple(item.position), chunk, filled });
    }
    checkStorage(chunks, checked);
    return new SparseGrid(empty.size, empty.origin, checked, chunks);
  }

  /** Filled cells, chunks and bytes. */
  get stats(): SparseStats {
    let filled = 0,
      bytes = 0;
    for (const entry of this.#chunks.values()) {
      filled += entry.filled;
      bytes += entry.chunk.byteLength;
    }
    return { filled, chunks: this.#chunks.size, bytes };
  }

  /** The box of filled cells, `max` exclusive, or null when the grid is empty. Visits held chunks only. */
  get bounds(): { min: MutableVec3; max: MutableVec3 } | null {
    const min = tuple(this.size),
      max: MutableVec3 = [0, 0, 0];
    let any = false;
    for (const [x, y, z] of this.filled()) {
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

  /** The palette index at local cell (x, y, z); integer cells outside the grid read as air (0). */
  get(x: number, y: number, z: number): number {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(z))
      throw new RangeError('SparseGrid.get takes whole cells; pass integers');
    if (!this.#inside(x, y, z)) return 0;
    return this.#chunks.get(chunkKey(chunkOf(x), chunkOf(y), chunkOf(z)))?.chunk.get(x % 32, y % 32, z % 32) ?? 0;
  }

  /**
   * Applies `edits` in order as one transaction (a later edit of the same cell wins) and returns the new snapshot.
   * Nothing is kept when any edit is invalid or a budget is exceeded.
   */
  edit(edits: Iterable<VoxelEdit>, limits: SparseLimits = {}): SparseEdit {
    const checked = checkLimits({ ...this.#limits, ...limits }),
      touched = new Map<string, Entry>(),
      changes = new Map<string, [before: number, after: number]>();
    let count = 0,
      added = 0;
    for (const edit of edits) {
      if (++count > checked.maxEdits)
        throw new RangeError('SparseGrid edit exceeds maxEdits; split it or raise maxEdits');
      if (!Array.isArray(edit) || edit.length !== 4)
        throw new TypeError('SparseGrid edit is not [x, y, z, index]; pass that');
      const [x, y, z, value] = edit;
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(z))
        throw new RangeError('SparseGrid edit cell is not whole; pass integer coordinates');
      if (!this.#inside(x, y, z))
        throw new RangeError(`SparseGrid edit cell ${x}, ${y}, ${z} is outside the grid bounds`);
      checkPalette(value, 'SparseGrid edit index', 0);
      const address = chunkKey(chunkOf(x), chunkOf(y), chunkOf(z)),
        original = this.#chunks.get(address);
      let entry = touched.get(address);
      const previous = (entry ?? original)?.chunk.get(x % 32, y % 32, z % 32) ?? 0;
      if (previous === value) continue;
      if (!entry) {
        if (!original && this.#chunks.size + ++added > checked.maxChunks)
          throw new RangeError('SparseGrid edit exceeds maxChunks; erase unused chunks or raise maxChunks');
        entry = {
          position: [chunkOf(x), chunkOf(y), chunkOf(z)],
          chunk: original ? VoxelChunk.unpack(original.chunk.pack()) : new VoxelChunk(),
          filled: original?.filled ?? 0,
        };
        touched.set(address, entry);
      }
      entry.chunk.set(x % 32, y % 32, z % 32, value);
      entry.filled += (value ? 1 : 0) - (previous ? 1 : 0);
      const cell = `${x},${y},${z}`,
        change = changes.get(cell);
      if (change) change[1] = value;
      else changes.set(cell, [previous, value]);
    }
    let changed = 0,
      bytes = 0;
    for (const [before, after] of changes.values()) if (before !== after) changed++;
    let chunks = this.#chunks;
    if (changed) {
      const next = new Map(this.#chunks);
      for (const [address, entry] of touched) {
        bytes += entry.chunk.byteLength + (this.#chunks.get(address)?.chunk.byteLength ?? 0);
        if (entry.filled) next.set(address, entry);
        else next.delete(address);
      }
      chunks = next;
    }
    checkStorage(chunks, checked);
    const grid = changed ? new SparseGrid(this.size, this.origin, this.#limits, chunks) : this,
      delta: SparseDelta = Object.freeze({ changed, bytes });
    history.set(delta, { before: this, after: grid });
    return { grid, delta };
  }

  /** The snapshot before or after the edit that returned `delta`; this grid must be one of the two. */
  restore(delta: SparseDelta, side: 'before' | 'after'): SparseGrid {
    if (side !== 'before' && side !== 'after')
      throw new TypeError("SparseGrid.restore side is unknown; pass 'before' or 'after'");
    const pair = history.get(delta);
    if (!pair || (this !== pair.before && this !== pair.after))
      throw new MargoError(
        'state',
        'SparseGrid.restore got a delta from a different grid; restore from its own snapshot',
      );
    return pair[side];
  }

  /** Every filled cell as [x, y, z, index], chunk by chunk (y, then z, then x); empty chunks are never visited. */
  *filled(): IterableIterator<VoxelEdit> {
    for (const { position, chunk } of this.#sorted()) {
      const [cx, cy, cz] = position,
        nx = Math.min(32, this.size[0] - cx * 32),
        ny = Math.min(32, this.size[1] - cy * 32),
        nz = Math.min(32, this.size[2] - cz * 32);
      for (let y = 0; y < ny; y++)
        for (let z = 0; z < nz; z++)
          for (let x = 0; x < nx; x++) {
            const value = chunk.get(x, y, z);
            if (value) yield [cx * 32 + x, cy * 32 + y, cz * 32 + z, value];
          }
    }
  }

  /** Each held chunk as a dense window of at most 32 x 32 x 32 cells, owned by the caller. */
  *windows(): IterableIterator<GridWindow> {
    for (const { position, chunk } of this.#sorted()) {
      const origin: MutableVec3 = [position[0] * 32, position[1] * 32, position[2] * 32],
        size: MutableVec3 = [0, 1, 2].map((axis) => Math.min(32, this.size[axis] - origin[axis])) as MutableVec3,
        [sx, sy, sz] = size,
        voxels = new Uint8Array(sx * sy * sz);
      for (let y = 0; y < sy; y++)
        for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) voxels[x + sx * (z + sz * y)] = chunk.get(x, y, z);
      yield { origin, size, voxels };
    }
  }

  /** A dense copy of the box at `origin` of `size` (at most `maxWindowCells` cells) inside the grid. */
  readWindow(origin: Vec3, size: Vec3, limits: SparseLimits = {}): GridWindow {
    const cells = this.#checkWindow(origin, size, limits),
      voxels = new Uint8Array(cells),
      [sx, sy, sz] = size;
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++)
          voxels[x + sx * (z + sz * y)] = this.get(origin[0] + x, origin[1] + y, origin[2] + z);
    return { origin: tuple(origin), size: tuple(size), voxels };
  }

  /** Replaces the box a window covers, air cells included, as one undoable edit. */
  writeWindow(window: GridWindow, limits: SparseLimits = {}): SparseEdit {
    const { origin, size, voxels } = window ?? ({} as GridWindow),
      cells = this.#checkWindow(origin, size, limits);
    if (!(voxels instanceof Uint8Array) || voxels.length !== cells)
      throw new RangeError(`SparseGrid window voxels do not hold ${cells} cells; match its size`);
    const grid = this;
    function* changes(): IterableIterator<VoxelEdit> {
      const [sx, sy, sz] = size;
      for (let y = 0; y < sy; y++)
        for (let z = 0; z < sz; z++)
          for (let x = 0; x < sx; x++) {
            const value = voxels[x + sx * (z + sz * y)],
              px = origin[0] + x,
              py = origin[1] + y,
              pz = origin[2] + z;
            if (value !== grid.get(px, py, pz)) yield [px, py, pz, value];
          }
    }
    return this.edit(changes(), limits);
  }

  /**
   * Casts a ray from `origin` along `direction` (local cells, any length but not zero) and returns the first filled
   * cell within `maxDistance`, visiting only chunks the ray crosses. A ray starting in a filled cell hits it at
   * distance 0 with a zero normal.
   */
  raycast(origin: Vec3, direction: Vec3, maxDistance = Infinity): GridHit | null {
    checkPoint(origin, 'SparseGrid.raycast origin');
    checkPoint(direction, 'SparseGrid.raycast direction');
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (!length) throw new RangeError('SparseGrid.raycast direction is zero; pass a nonzero direction');
    if (!(maxDistance >= 0)) throw new RangeError('SparseGrid.raycast maxDistance is negative; pass 0 or more');
    const dir: MutableVec3 = [direction[0] / length, direction[1] / length, direction[2] / length],
      start: MutableVec3 = [Math.floor(origin[0]), Math.floor(origin[1]), Math.floor(origin[2])],
      startValue = Number.isSafeInteger(start[0]) ? this.get(...start) : 0;
    if (startValue) return { cell: start, adjacent: tuple(start), normal: [0, 0, 0], value: startValue, distance: 0 };
    let best: GridHit | null = null;
    for (const { position, chunk } of this.#chunks.values()) {
      const low = position.map((v) => v * 32) as MutableVec3,
        high = low.map((v, axis) => Math.min(v + 32, this.size[axis])) as MutableVec3,
        span = rayBox(origin, dir, low, high, best?.distance ?? maxDistance);
      if (!span) continue;
      const t = Math.max(0, span.near),
        cell = [0, 1, 2].map((axis) =>
          Math.min(high[axis] - 1, Math.max(low[axis], Math.floor(origin[axis] + dir[axis] * (t + 1e-7)))),
        ) as MutableVec3;
      let distance = t,
        normal = span.normal;
      for (let steps = 0; steps < 100 && distance <= span.far; steps++) {
        const value = chunk.get(cell[0] - low[0], cell[1] - low[1], cell[2] - low[2]);
        if (value) {
          if (!best || distance < best.distance)
            best = {
              cell: tuple(cell),
              adjacent: [cell[0] + normal[0], cell[1] + normal[1], cell[2] + normal[2]],
              normal: tuple(normal),
              value,
              distance,
            };
          break;
        }
        const crossing = dir.map((d, axis) => (d ? (cell[axis] + (d > 0 ? 1 : 0) - origin[axis]) / d : Infinity)),
          next = Math.min(...crossing);
        distance = next;
        normal = [0, 0, 0];
        let first = true;
        for (let axis = 0; axis < 3; axis++)
          if (crossing[axis] <= next + 1e-8) {
            cell[axis] += dir[axis] > 0 ? 1 : -1;
            if (first) {
              normal[axis] = dir[axis] > 0 ? -1 : 1;
              first = false;
            }
          }
        if (cell.some((v, axis) => v < low[axis] || v >= high[axis])) break;
      }
    }
    return best;
  }

  /** The grid as {@link SparseGridData}: plain arrays, safe to `JSON.stringify`. */
  serialize(limits: SparseLimits = {}): SparseGridData {
    checkStorage(this.#chunks, checkLimits({ ...this.#limits, ...limits }));
    return {
      format: 'margo-sparse-volume',
      version: 1,
      size: tuple(this.size),
      origin: tuple(this.origin),
      chunks: this.#sorted().map(({ position, chunk }) => {
        const packed = chunk.pack();
        if (packed.bits === 16) throw new RangeError('SparseGrid chunk holds an index above 255; fix the grid');
        return {
          position: tuple(position),
          palette: Array.from(packed.palette),
          bits: packed.bits,
          words: Array.from(packed.words),
        };
      }),
    };
  }

  /**
   * Writes every filled cell into a @margoengine/voxel world at `origin + cell`, the palette index as the block id.
   * The world must have air at all those cells and a Y range covering them; nothing is written when a check fails.
   */
  toWorld(world: VoxelWorld): void {
    const [ox, oy, oz] = this.origin;
    for (const [x, y, z, value] of this.filled()) {
      world.blocks.get(value);
      if (y + oy < world.minY || y + oy > world.maxY)
        throw new RangeError('SparseGrid.toWorld cells fall outside the world Y range; widen it or move the origin');
      if (world.getBlock(x + ox, y + oy, z + oz))
        throw new MargoError('state', 'SparseGrid.toWorld target cells are not empty; write into an empty world');
    }
    for (const [x, y, z, value] of this.filled()) world.setBlock(x + ox, y + oy, z + oz, value);
  }

  #inside(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.size[0] && y < this.size[1] && z < this.size[2];
  }

  #sorted(): Entry[] {
    return [...this.#chunks.values()].sort(
      (a, b) => a.position[1] - b.position[1] || a.position[2] - b.position[2] || a.position[0] - b.position[0],
    );
  }

  #checkWindow(origin: Vec3, size: Vec3, limits: SparseLimits): number {
    checkCell(origin, 'SparseGrid window origin');
    checkCell(size, 'SparseGrid window size');
    const cells = size[0] * size[1] * size[2];
    if (size.some((v) => v < 1)) throw new RangeError('SparseGrid window has an empty axis; pass sizes of at least 1');
    if (!Number.isSafeInteger(cells) || cells > checkLimits({ ...this.#limits, ...limits }).maxWindowCells)
      throw new RangeError('SparseGrid window exceeds maxWindowCells; use a smaller window');
    if (origin.some((v, axis) => v < 0 || v + size[axis] > this.size[axis]))
      throw new RangeError('SparseGrid window reaches outside the grid; keep it inside the bounds');
    return cells;
  }
}

/** Options of {@link editWindow}. */
export interface WindowEditOptions extends SparseLimits {
  /** Local cell of the box's lower corner. */
  origin: Vec3;
  /** Cells along x, y and z. */
  size: Vec3;
  /**
   * `'fill'` fills every cell, `'erase'` empties them, `'paint'` recolours filled ones, `'dilate'` fills air next to a
   * filled cell, `'erode'` empties filled cells next to air. Dilate and erode read neighbours outside the box but
   * write only inside it.
   */
  operation: 'fill' | 'erase' | 'paint' | 'dilate' | 'erode';
  /** Palette index for fill and paint (required) and dilate (default: the filled neighbour's index), 1-255. */
  color?: number;
}

/** Applies one operation to a box of a sparse grid as a single undoable edit. */
export function editWindow(grid: SparseGrid, options: WindowEditOptions): SparseEdit {
  if (typeof options !== 'object' || options === null) throw new TypeError('editWindow options are missing; pass them');
  const operation = options.operation;
  if (!['fill', 'erase', 'paint', 'dilate', 'erode'].includes(operation))
    throw new TypeError("editWindow operation is unknown; pass 'fill', 'erase', 'paint', 'dilate' or 'erode'");
  if (operation === 'fill' || operation === 'paint' || options.color !== undefined)
    checkPalette(options.color, 'editWindow color');
  const window = grid.readWindow(options.origin, options.size, options),
    voxels = window.voxels,
    [sx, sy, sz] = window.size,
    [ox, oy, oz] = window.origin;
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const index = x + sx * (z + sz * y),
          value = voxels[index];
        if (operation === 'fill') voxels[index] = options.color!;
        else if (operation === 'erase') voxels[index] = 0;
        else if (operation === 'paint') {
          if (value) voxels[index] = options.color!;
        } else if (operation === 'dilate' ? !value : value) {
          let neighbour = 0,
            air = false;
          for (const [dx, dy, dz] of SIX) {
            const n = grid.get(ox + x + dx, oy + y + dy, oz + z + dz);
            if (!n) air = true;
            else if (!neighbour) neighbour = n;
          }
          if (operation === 'dilate' && neighbour) voxels[index] = options.color ?? neighbour;
          if (operation === 'erode' && air) voxels[index] = 0;
        }
      }
  return grid.writeWindow(window, options);
}

function checkLimits(value: SparseLimits): Limits {
  const result = { ...DEFAULTS, ...value };
  for (const name of Object.keys(DEFAULTS) as (keyof Limits)[])
    if (!Number.isSafeInteger(result[name]) || result[name] < 1 || result[name] > DEFAULTS[name] * 4)
      throw new RangeError(`SparseGrid ${name} is out of range; pass an integer from 1 to ${DEFAULTS[name] * 4}`);
  return result;
}

function checkExtent(size: Vec3, origin: Vec3): void {
  checkCell(size, 'SparseGrid size');
  checkCell(origin, 'SparseGrid origin');
  if (size.some((v) => v < 1) || !Number.isSafeInteger(size[0] * size[1] * size[2]))
    throw new RangeError('SparseGrid size must be positive with a safe-integer cell count; pass a smaller size');
  for (let axis = 0; axis < 3; axis++) {
    const low = axis === 1 ? -32768 : -2147483648,
      high = axis === 1 ? 32767 : 2147483647;
    if (origin[axis] < low || origin[axis] + size[axis] - 1 > high)
      throw new RangeError(
        `SparseGrid ${axis === 1 ? 'Y' : 'X/Z'} extent leaves the engine's cell range; move the origin or shrink the size`,
      );
  }
}

function checkStorage(chunks: ReadonlyMap<string, Entry>, limits: Limits): void {
  if (chunks.size > limits.maxChunks)
    throw new RangeError('SparseGrid exceeds maxChunks; erase unused chunks or raise it');
  let bytes = 0;
  for (const entry of chunks.values()) bytes += entry.chunk.byteLength;
  if (bytes > limits.maxBytes) throw new RangeError('SparseGrid exceeds maxBytes; erase unused chunks or raise it');
}

function rayBox(
  origin: Vec3,
  direction: Vec3,
  low: Vec3,
  high: Vec3,
  max: number,
): { near: number; far: number; normal: MutableVec3 } | null {
  let near = 0,
    far = max,
    normal: MutableVec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    if (!direction[axis]) {
      if (origin[axis] < low[axis] || origin[axis] >= high[axis]) return null;
      continue;
    }
    let a = (low[axis] - origin[axis]) / direction[axis],
      b = (high[axis] - origin[axis]) / direction[axis];
    if (a > b) [a, b] = [b, a];
    if (a >= near) {
      near = a;
      normal = [0, 0, 0];
      normal[axis] = direction[axis] > 0 ? -1 : 1;
    }
    far = Math.min(far, b);
    if (far <= near) return null;
  }
  return { near, far, normal };
}
