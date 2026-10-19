import { MargoError } from '@margoengine/math/errors';
import { BlockTypes } from './blocks.js';
import { stateError, VoxelChunk } from './chunk.js';

/** Key of chunk (cx, cy, cz) in {@link VoxelWorld.dirty}: `'cx,cy,cz'`. Chunk coordinates are cell >> 5. */
export const chunkKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

/** Options of {@link VoxelWorld}. */
export interface VoxelWorldOptions {
  /** The block types states refer to: setBlock rejects ids it does not define. */
  blocks: BlockTypes;
  /** Lowest cell y, inclusive. Default -32768 (heightmaps are 16-bit). */
  minY?: number;
  /** Highest cell y, inclusive. Default 32767. */
  maxY?: number;
}

const cellError = (x: unknown, y: unknown, z: unknown): Error =>
  [x, y, z].every((v) => typeof v === 'number')
    ? new RangeError(`Cell (${x}, ${y}, ${z}) is not three 32-bit integers; floor positions to cells first`)
    : new TypeError('Cell coordinates must be numbers');
const chunkError = (cx: unknown, cy: unknown, cz: unknown): Error =>
  [cx, cy, cz].every((v) => typeof v === 'number')
    ? new RangeError(`Chunk (${cx}, ${cy}, ${cz}) is not three integers in -2^26..2^26-1; pass cell >> 5`)
    : new TypeError('Chunk coordinates must be numbers');
// Chunk coordinates are cell >> 5 of a 32-bit cell coordinate: 27-bit signed integers.
const isChunk = (c: number): boolean => (c << 5) >> 5 === c;

/**
 * A chunked voxel world: {@link VoxelChunk}s keyed by chunk coordinates, cells addressed by 32-bit integer
 * coordinates (an unloaded cell reads as air, 0). Edits through {@link VoxelWorld.setBlock} and
 * {@link VoxelWorld.setBlocks} mark the edited chunk dirty, and also each loaded neighbour whose one-cell border shell
 * holds the cell (up to 7 for a corner), then call the {@link VoxelWorld.onChange} listeners.
 */
export class VoxelWorld {
  /** The block types this world's states refer to. */
  readonly blocks: BlockTypes;
  /** Lowest cell y, inclusive. */
  readonly minY: number;
  /** Highest cell y, inclusive. */
  readonly maxY: number;
  /**
   * Keys ({@link chunkKey}) of chunks to remesh: their cells or their neighbours' border cells changed, or they were
   * added; a key with no chunk was removed (drop its mesh). The consumer deletes the keys it handled.
   */
  readonly dirty = new Set<string>();
  private readonly chunks = new Map<string, VoxelChunk>();
  private readonly columns = new Map<string, { heights: Int16Array; chunks: number }>();
  private readonly listeners = new Set<(x: number, y: number, z: number, state: number, previous: number) => void>();
  // The last chunk looked up (or found missing), so runs of nearby reads and edits build no keys.
  private cx = Number.NaN;
  private cy = 0;
  private cz = 0;
  private key = '';
  private chunk: VoxelChunk | undefined;
  /**
   * @throws TypeError when `options.blocks` is not a {@link BlockTypes} or minY/maxY is not a number.
   * @throws RangeError unless minY and maxY are integers with -32768 <= minY <= maxY <= 32767.
   */
  constructor(options: VoxelWorldOptions) {
    if (!(options?.blocks instanceof BlockTypes))
      throw new TypeError('VoxelWorld needs {blocks}: pass {blocks: new BlockTypes()}');
    const { minY = -32768, maxY = 32767 } = options;
    if (typeof minY !== 'number' || typeof maxY !== 'number')
      throw new TypeError('VoxelWorld minY and maxY must be numbers');
    if (!Number.isInteger(minY) || !Number.isInteger(maxY) || minY < -32768 || maxY > 32767 || minY > maxY)
      throw new RangeError(
        `VoxelWorld y range ${minY}..${maxY} is invalid; use integers in -32768..32767, minY <= maxY`,
      );
    this.blocks = options.blocks;
    this.minY = minY;
    this.maxY = maxY;
  }
  /**
   * Block state of cell (x, y, z); 0 (air) in an unloaded chunk or outside minY..maxY.
   * @throws RangeError (TypeError for non-numbers) when a coordinate is not a 32-bit integer.
   */
  getBlock(x: number, y: number, z: number): number {
    if ((x | 0) !== x || (y | 0) !== y || (z | 0) !== z) throw cellError(x, y, z);
    if (y < this.minY || y > this.maxY) return 0;
    const chunk = this.at(x >> 5, y >> 5, z >> 5);
    return chunk ? chunk.get(x & 31, y & 31, z & 31) : 0;
  }
  /**
   * Sets cell (x, y, z) to `state` (a block id, or {@link blockState}) and returns its previous state. A non-air
   * state in an unloaded chunk adds an air chunk there first.
   * @throws RangeError (TypeError for non-numbers) for a coordinate that is not a 32-bit integer, y outside
   * minY..maxY, a state that is not a u32, or a block id that `blocks` does not define.
   */
  setBlock(x: number, y: number, z: number, state: number): number {
    this.check(x, y, z, state);
    return this.write(x, y, z, state);
  }
  /**
   * Applies `edits`, a flat `[x, y, z, state, ...]` list (an Int32Array works: negative states are read as their
   * u32 bit pattern), and returns how many cells changed. Every edit is checked before any is applied.
   * @throws TypeError when `edits` is not an array-like of quadruples; otherwise as {@link VoxelWorld.setBlock}.
   */
  setBlocks(edits: ArrayLike<number>): number {
    if (!edits || typeof edits !== 'object' || !Number.isInteger(edits.length) || edits.length % 4)
      throw new TypeError('setBlocks expects a flat [x, y, z, state, ...] array of quadruples');
    const n = edits.length,
      state = (i: number) => ((edits[i] | 0) === edits[i] ? edits[i] >>> 0 : edits[i]);
    for (let i = 0; i < n; i += 4) this.check(edits[i], edits[i + 1], edits[i + 2], state(i + 3));
    let changed = 0;
    for (let i = 0; i < n; i += 4) {
      const s = state(i + 3);
      if (this.write(edits[i], edits[i + 1], edits[i + 2], s) !== s) changed++;
    }
    return changed;
  }
  /**
   * The chunk at chunk coordinates (cx, cy, cz), or undefined when it is not loaded.
   * @throws RangeError (TypeError for non-numbers) for coordinates that are not chunk coordinates (cell >> 5).
   */
  getChunk(cx: number, cy: number, cz: number): VoxelChunk | undefined {
    if (!isChunk(cx) || !isChunk(cy) || !isChunk(cz)) throw chunkError(cx, cy, cz);
    return this.chunks.get(chunkKey(cx, cy, cz));
  }
  /**
   * Adds `chunk` (default: a new air chunk) at chunk coordinates (cx, cy, cz) and returns it. Marks it and its 26
   * loaded neighbours dirty and creates the column's heightmap if this is its first chunk. Fires no change events.
   * @throws TypeError when `chunk` is not a VoxelChunk.
   * @throws RangeError for invalid chunk coordinates or a chunk entirely outside minY..maxY.
   * @throws MargoError `'state'` when a chunk is already loaded there.
   */
  addChunk(cx: number, cy: number, cz: number, chunk: VoxelChunk = new VoxelChunk()): VoxelChunk {
    if (!isChunk(cx) || !isChunk(cy) || !isChunk(cz)) throw chunkError(cx, cy, cz);
    if (!(chunk instanceof VoxelChunk))
      throw new TypeError('addChunk expects a VoxelChunk; create one with new VoxelChunk() or VoxelChunk.unpack()');
    if (cy * 32 > this.maxY || cy * 32 + 31 < this.minY)
      throw new RangeError(`Chunk y ${cy} is outside this world's cells ${this.minY}..${this.maxY}; widen minY/maxY`);
    const key = chunkKey(cx, cy, cz);
    if (this.chunks.has(key))
      throw new MargoError('state', `Chunk ${key} is already loaded; removeChunk(${key}) before adding another`);
    this.chunks.set(key, chunk);
    this.cx = Number.NaN;
    const column = this.columns.get(`${cx},${cz}`);
    if (column) column.chunks++;
    else this.columns.set(`${cx},${cz}`, { heights: new Int16Array(1024).fill(-32768), chunks: 1 });
    this.dirty.add(key);
    this.touch(cx, cy, cz, -1, 1, -1, 1, -1, 1);
    return chunk;
  }
  /**
   * Removes and returns the chunk at (cx, cy, cz), or undefined when none is loaded. Its key stays dirty (so its mesh
   * is dropped) with its 26 loaded neighbours; the column's heightmap goes with its last chunk. Fires no change events.
   * @throws RangeError (TypeError for non-numbers) for invalid chunk coordinates.
   */
  removeChunk(cx: number, cy: number, cz: number): VoxelChunk | undefined {
    if (!isChunk(cx) || !isChunk(cy) || !isChunk(cz)) throw chunkError(cx, cy, cz);
    const key = chunkKey(cx, cy, cz),
      chunk = this.chunks.get(key);
    if (!chunk) return undefined;
    this.chunks.delete(key);
    this.cx = Number.NaN;
    const column = this.columns.get(`${cx},${cz}`);
    if (column && !--column.chunks) this.columns.delete(`${cx},${cz}`);
    this.dirty.add(key);
    this.touch(cx, cy, cz, -1, 1, -1, 1, -1, 1);
    return chunk;
  }
  /**
   * The heightmap of chunk column (cx, cz) while any of its chunks is loaded: 32 x 32 int16 heights, index
   * `x | z << 5` (local x, z), each the y of the column's highest light-blocking cell or -32768 for none. Starts at
   * -32768; `@margoengine/voxel/light` fills it to seed sky light.
   * @throws RangeError (TypeError for non-numbers) for invalid chunk coordinates.
   */
  heightmap(cx: number, cz: number): Int16Array | undefined {
    if (!isChunk(cx) || !isChunk(cz)) throw chunkError(cx, 0, cz);
    return this.columns.get(`${cx},${cz}`)?.heights;
  }
  /**
   * Calls `listener(x, y, z, state, previous)` after each cell that setBlock or setBlocks changes (once per cell,
   * in edit order). Returns an unsubscribe function.
   * @throws TypeError when `listener` is not a function.
   */
  onChange(listener: (x: number, y: number, z: number, state: number, previous: number) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('onChange expects a function (x, y, z, state, previous)');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private at(cx: number, cy: number, cz: number): VoxelChunk | undefined {
    if (cx !== this.cx || cy !== this.cy || cz !== this.cz) {
      this.cx = cx;
      this.cy = cy;
      this.cz = cz;
      this.key = chunkKey(cx, cy, cz);
      this.chunk = this.chunks.get(this.key);
    }
    return this.chunk;
  }
  private check(x: number, y: number, z: number, state: number): void {
    if ((x | 0) !== x || (y | 0) !== y || (z | 0) !== z) throw cellError(x, y, z);
    if (y < this.minY || y > this.maxY)
      throw new RangeError(`Cell y ${y} is outside this world's ${this.minY}..${this.maxY}; widen minY/maxY`);
    if (state >>> 0 !== state) throw stateError(state);
    if ((state & 0xffff) >= this.blocks.table.length)
      throw new RangeError(`Block id ${state & 0xffff} is not defined; define it with blocks.define() first`);
  }
  private write(x: number, y: number, z: number, state: number): number {
    const cx = x >> 5,
      cy = y >> 5,
      cz = z >> 5,
      lx = x & 31,
      ly = y & 31,
      lz = z & 31;
    let chunk = this.at(cx, cy, cz);
    if (!chunk) {
      if (!state) return 0;
      chunk = this.addChunk(cx, cy, cz);
      this.at(cx, cy, cz);
    }
    const previous = chunk.set(lx, ly, lz, state);
    if (previous === state) return previous;
    this.dirty.add(this.key);
    this.touch(
      cx,
      cy,
      cz,
      lx ? 0 : -1,
      lx === 31 ? 1 : 0,
      ly ? 0 : -1,
      ly === 31 ? 1 : 0,
      lz ? 0 : -1,
      lz === 31 ? 1 : 0,
    );
    for (const listener of this.listeners) listener(x, y, z, state, previous);
    return previous;
  }
  // Marks the loaded chunks at offsets x0..x1, y0..y1, z0..z1 (each -1..1) from (cx, cy, cz) dirty, except itself.
  private touch(
    cx: number,
    cy: number,
    cz: number,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
  ): void {
    for (let dx = x0; dx <= x1; dx++)
      for (let dy = y0; dy <= y1; dy++)
        for (let dz = z0; dz <= z1; dz++) {
          if (!(dx | dy | dz)) continue;
          const key = chunkKey(cx + dx, cy + dy, cz + dz);
          if (this.chunks.has(key)) this.dirty.add(key);
        }
  }
}
