import { integerError } from './blocks.js';

/** Edge length of a chunk in cells: a chunk is 32 x 32 x 32 = 32,768 cells. Chunk coordinates are cell >> 5. */
export const CHUNK_SIZE = 32;
const CELLS = 32768;
type Bits = 0 | 1 | 2 | 4 | 8 | 16;

/**
 * A chunk as plain typed arrays, from {@link VoxelChunk.pack}: post it to a worker with every array's buffer in the
 * transfer list (each array owns its whole buffer and shares nothing with the chunk).
 */
export interface PackedChunk {
  /** Block states the cell indices refer to; at most 2^bits and 32,768 entries. Entries no cell uses are allowed. */
  palette: Uint32Array;
  /** Bits per cell index: 0 (every cell is `palette[0]`), 1, 2, 4, 8 or 16. */
  bits: 0 | 1 | 2 | 4 | 8 | 16;
  /**
   * 1,024 x `bits` words. Cell `i = x | z << 5 | y << 10` is bits `i * bits` to `(i + 1) * bits - 1`, low bits first;
   * an index never straddles two words. Empty when `bits` is 0.
   */
  words: Uint32Array;
  /** One light byte per cell (sky light in the high nibble, block light in the low), or one byte for every cell. */
  light: number | Uint8Array;
}

const widthFor = (n: number): Bits => (n <= 1 ? 0 : n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : n <= 256 ? 8 : 16);
const capacity = (bits: number): number => (bits ? Math.min(1 << bits, CELLS) : 1);
const cellError = (x: unknown, y: unknown, z: unknown): Error =>
  [x, y, z].every((v) => typeof v === 'number')
    ? new RangeError(`Chunk cell (${x}, ${y}, ${z}) is not in 0..31; pass local coordinates (cell & 31)`)
    : new TypeError('Chunk cell coordinates must be numbers');
export const stateError = (state: unknown): Error =>
  integerError('Block state', state, 0xffffffff, 'build it with blockState(id, data)');
const packedError = (problem: string): Error =>
  new RangeError(`PackedChunk ${problem}; pass the result of chunk.pack()`);

// Cell indices from `bits`-bit `words`, re-encoded at `to` bits through `remap` (old slot -> new slot).
function reencode(bits: number, words: Uint32Array | null, to: number, remap: Uint16Array | null): Uint32Array | null {
  if (!to) return null;
  const out = new Uint32Array(1024 * to),
    mask = (1 << bits) - 1;
  if ((!bits || !words) && !remap?.[0]) return out; // every cell was and stays slot 0
  for (let cell = 0; cell < CELLS; cell++) {
    let s = bits && words ? (words[(cell * bits) >>> 5] >>> ((cell * bits) & 31)) & mask : 0;
    if (remap) s = remap[s];
    if (s) out[(cell * to) >>> 5] |= s << ((cell * to) & 31);
  }
  return out;
}

/**
 * Package-internal (the package entry does not export it): widens the cell indices once so that `set` can add those
 * of the first `count` `states` that the palette lacks without widening again (one re-encode instead of one per
 * width step).
 */
export let reserveCells: (chunk: VoxelChunk, states: ArrayLike<number>, count: number) => void;
/** Package-internal: after sets prepared by {@link reserveCells}, narrows indices the remaining states do not need. */
export let settleCells: (chunk: VoxelChunk) => void;
/** The state every cell of `chunk` holds when it is uniform (its palette alone), else undefined. */
export let uniformState: (chunk: VoxelChunk) => number | undefined;
/** The states `chunk`'s cells use, possibly with unused ones (as `pack` gives them), as a view: no copy. */
export let paletteOf: (chunk: VoxelChunk) => Uint32Array;
/** The chunk's light: its one byte while every cell has it, else a copy of the 32,768 bytes. */
export let lightOf: (chunk: VoxelChunk) => number | Uint8Array;
/** Internal light change counter for optional renderers sharing the world's dirty queue. */
export let lightVersion: (chunk: VoxelChunk) => number;
/** Replaces the chunk's light with one byte for every cell or 32,768 bytes (taken, not copied). */
export let writeLight: (chunk: VoxelChunk, light: number | Uint8Array) => void;

/**
 * The 32,768 block states and light bytes of one chunk. States are stored as indices into a palette of the distinct
 * states, 0, 1, 2, 4, 8 or 16 bits per cell: a uniform chunk is its palette alone. Palette entries are reference
 * counted, so the index width grows as states are added and shrinks back as they disappear. Light is one byte for
 * every cell until a cell gets a different one. Cells are local (0..31 per axis); edit loaded chunks through
 * {@link VoxelWorld} to keep its dirty set and change events.
 */
export class VoxelChunk {
  private palette = new Uint32Array(1);
  private counts = Uint16Array.of(CELLS);
  private size = 1; // palette slots in use: live, or free when their count is 0
  private live = 1;
  private free: number[] = [];
  private lookup: Map<number, number> | null = null; // state -> slot, once the palette outgrows 16 entries
  private bits: Bits = 0;
  private words: Uint32Array | null = null;
  private lightByte = 0;
  private lightRevision = 0;
  private lightCells: Uint8Array | null = null;
  static {
    lightVersion = (chunk) => chunk.lightRevision;
    reserveCells = (chunk, states, count) => {
      const missing = new Set<number>();
      for (let i = 0; i < count; i++) if (chunk.find(states[i]) < 0) missing.add(states[i]);
      const slots = chunk.size + missing.size - chunk.free.length;
      if (slots > chunk.palette.length && chunk.palette.length < CELLS) chunk.grow(slots);
    };
    settleCells = (chunk) => {
      if (chunk.bits && (chunk.live === 1 || widthFor(2 * chunk.live) < chunk.bits)) chunk.compact();
    };
    uniformState = (chunk) => (chunk.bits ? undefined : chunk.palette[0]);
    paletteOf = (chunk) => chunk.palette.subarray(0, chunk.size);
    lightOf = (chunk) => (chunk.lightCells ? chunk.lightCells.slice() : chunk.lightByte);
    writeLight = (chunk, light) => {
      chunk.lightRevision++;
      if (typeof light === 'number') {
        chunk.lightByte = light;
        chunk.lightCells = null;
      } else chunk.lightCells = light;
    };
  }
  /**
   * A uniform chunk: every cell is `state` (default 0, air) and every light byte 0.
   * @throws TypeError or RangeError when `state` is not an unsigned 32-bit integer.
   */
  constructor(state = 0) {
    this.fill(state);
  }
  /**
   * Block state of local cell (x, y, z).
   * @throws RangeError (TypeError for non-numbers) when a coordinate is not an integer in 0..31.
   */
  get(x: number, y: number, z: number): number {
    if ((x & 31) !== x || (y & 31) !== y || (z & 31) !== z) throw cellError(x, y, z);
    return this.palette[this.slot(x | (z << 5) | (y << 10))];
  }
  /**
   * Sets local cell (x, y, z) to `state` and returns its previous state.
   * @throws RangeError (TypeError for non-numbers) for a coordinate outside 0..31 or a state that is not a u32.
   */
  set(x: number, y: number, z: number, state: number): number {
    if ((x & 31) !== x || (y & 31) !== y || (z & 31) !== z) throw cellError(x, y, z);
    if (state >>> 0 !== state) throw stateError(state);
    const cell = x | (z << 5) | (y << 10),
      old = this.slot(cell),
      previous = this.palette[old];
    if (previous === state) return previous;
    let slot = this.find(state);
    if (slot < 0 && this.counts[old] === 1) {
      // The cell held the last use of its state: its slot takes the new state, so the palette never exceeds 32,768.
      this.lookup?.delete(previous);
      this.palette[old] = state;
      this.lookup?.set(state, old);
      return previous;
    }
    if (slot < 0) slot = this.add(state);
    const bits = this.bits,
      bit = cell * bits,
      i = bit >>> 5,
      shift = bit & 31,
      words = this.words as Uint32Array;
    words[i] = (words[i] & ~(((1 << bits) - 1) << shift)) | (slot << shift);
    this.counts[slot]++;
    if (--this.counts[old] === 0) this.release(old);
    return previous;
  }
  /**
   * Sets every cell to `state`; the chunk becomes uniform (its palette alone). Light is unchanged.
   * @throws TypeError or RangeError when `state` is not an unsigned 32-bit integer.
   */
  fill(state: number): void {
    if (state >>> 0 !== state) throw stateError(state);
    this.palette = Uint32Array.of(state);
    this.counts = Uint16Array.of(CELLS);
    this.size = this.live = 1;
    this.free = [];
    this.lookup = null;
    this.bits = 0;
    this.words = null;
  }
  /**
   * Light byte of local cell (x, y, z): sky light (0-15) in the high nibble, block light (0-15) in the low.
   * @throws RangeError (TypeError for non-numbers) when a coordinate is not an integer in 0..31.
   */
  getLight(x: number, y: number, z: number): number {
    if ((x & 31) !== x || (y & 31) !== y || (z & 31) !== z) throw cellError(x, y, z);
    return this.lightCells ? this.lightCells[x | (z << 5) | (y << 10)] : this.lightByte;
  }
  /**
   * Sets the light byte of local cell (x, y, z) (`sky << 4 | block`). The first byte that differs from the others
   * allocates the 32 KiB per-cell array.
   * @throws RangeError (TypeError for non-numbers) for a coordinate outside 0..31 or a byte outside 0..255.
   */
  setLight(x: number, y: number, z: number, light: number): void {
    if ((x & 31) !== x || (y & 31) !== y || (z & 31) !== z) throw cellError(x, y, z);
    if ((light & 255) !== light) throw integerError('Light byte', light, 255, 'pass sky << 4 | block');
    if (this.getLight(x, y, z) === light) return;
    this.lightRevision++;
    if (!this.lightCells) {
      if (light === this.lightByte) return;
      this.lightCells = new Uint8Array(CELLS).fill(this.lightByte);
    }
    this.lightCells[x | (z << 5) | (y << 10)] = light;
  }
  /**
   * Sets every cell's light byte to `light` (`sky << 4 | block`), so the chunk keeps one byte for all of them again.
   * @throws RangeError (TypeError for non-numbers) for a byte outside 0..255.
   */
  fillLight(light: number): void {
    if ((light & 255) !== light) throw integerError('Light byte', light, 255, 'pass sky << 4 | block');
    if (this.lightCells || this.lightByte !== light) this.lightRevision++;
    this.lightByte = light;
    this.lightCells = null;
  }
  /** Bytes of the typed arrays the chunk holds now (palette, its counts, cell indices and per-cell light). */
  get byteLength(): number {
    return (
      this.palette.byteLength +
      this.counts.byteLength +
      (this.words?.byteLength ?? 0) +
      (this.lightCells?.byteLength ?? 0)
    );
  }
  /** A copy of the chunk as transferable typed arrays; {@link VoxelChunk.unpack} rebuilds it. */
  pack(): PackedChunk {
    return {
      palette: this.palette.slice(0, this.size),
      bits: this.bits,
      words: this.words ? this.words.slice() : new Uint32Array(0),
      light: this.lightCells ? this.lightCells.slice() : this.lightByte,
    };
  }
  /**
   * A chunk from {@link VoxelChunk.pack}'s output (copied, so `packed` stays usable). Duplicate or unused palette
   * entries are merged away and an index width wider than needed shrinks.
   * @throws TypeError when `packed` or one of its arrays has the wrong type.
   * @throws RangeError for a bit width other than 0, 1, 2, 4, 8 or 16, wrong array lengths, a light byte outside
   * 0..255, or a cell index past the palette.
   */
  static unpack(packed: PackedChunk): VoxelChunk {
    if (!packed || typeof packed !== 'object')
      throw new TypeError('PackedChunk must be the object chunk.pack() returns');
    const { palette, bits, words, light } = packed;
    if (!(palette instanceof Uint32Array) || !(words instanceof Uint32Array))
      throw new TypeError('PackedChunk palette and words must be Uint32Arrays; pass the result of chunk.pack()');
    if (![0, 1, 2, 4, 8, 16].includes(bits)) throw packedError(`bits ${bits} is not 0, 1, 2, 4, 8 or 16`);
    const cap = capacity(bits);
    if (palette.length < 1 || palette.length > cap)
      throw packedError(`palette has ${palette.length} entries where ${bits}-bit indices allow 1..${cap}`);
    if (words.length !== 1024 * bits) throw packedError(`words has ${words.length} entries, not ${1024 * bits}`);
    if (typeof light === 'number') {
      if ((light & 255) !== light) throw packedError(`light byte ${light} is not in 0..255`);
    } else if (!(light instanceof Uint8Array)) throw new TypeError('PackedChunk light must be a byte or a Uint8Array');
    else if (light.length !== CELLS) throw packedError(`light has ${light.length} bytes, not ${CELLS}`);
    const chunk = new VoxelChunk(),
      counts = new Uint16Array(cap),
      mask = (1 << bits) - 1;
    if (!bits) counts[0] = CELLS;
    else
      for (let cell = 0; cell < CELLS; cell++) {
        const s = (words[(cell * bits) >>> 5] >>> ((cell * bits) & 31)) & mask;
        if (s >= palette.length) throw packedError(`cell ${cell} uses palette entry ${s} of ${palette.length}`);
        counts[s]++;
      }
    chunk.palette = new Uint32Array(cap);
    chunk.palette.set(palette);
    chunk.counts = counts;
    chunk.size = palette.length;
    chunk.bits = bits;
    chunk.words = bits ? words.slice() : null;
    chunk.lightByte = typeof light === 'number' ? light : 0;
    chunk.lightCells = typeof light === 'number' ? null : light.slice();
    const states = new Set<number>();
    let live = 0;
    for (let s = 0; s < palette.length; s++)
      if (counts[s]) {
        live++;
        states.add(palette[s]);
      } else chunk.free.push(s);
    chunk.live = live;
    if (states.size < live || live === 1 || widthFor(2 * live) < bits) chunk.compact();
    else if (cap > 16) {
      chunk.lookup = new Map();
      for (let s = 0; s < palette.length; s++) if (counts[s]) chunk.lookup.set(palette[s], s);
    }
    return chunk;
  }
  private slot(cell: number): number {
    const bits = this.bits,
      bit = cell * bits;
    return bits ? ((this.words as Uint32Array)[bit >>> 5] >>> (bit & 31)) & ((1 << bits) - 1) : 0;
  }
  private find(state: number): number {
    if (this.lookup) return this.lookup.get(state) ?? -1;
    const { palette, counts, size } = this;
    for (let s = 0; s < size; s++) if (palette[s] === state && counts[s]) return s;
    return -1;
  }
  // Widens the indices to hold `slots` palette slots; a wider width keeps every slot number.
  private grow(slots: number): void {
    const bits = widthFor(slots),
      cap = capacity(bits),
      palette = new Uint32Array(cap),
      counts = new Uint16Array(cap);
    palette.set(this.palette);
    counts.set(this.counts);
    this.words = reencode(this.bits, this.words, bits, null);
    this.palette = palette;
    this.counts = counts;
    this.bits = bits;
    if (cap > 16) this.lookup ??= new Map(Array.from(palette.subarray(0, this.size), (s, slot) => [s, slot]));
  }
  private add(state: number): number {
    if (!this.free.length && this.size === this.palette.length) this.grow(this.size + 1);
    const slot = this.free.pop() ?? this.size++;
    this.palette[slot] = state;
    this.lookup?.set(state, slot);
    this.live++;
    return slot;
  }
  private release(slot: number): void {
    this.lookup?.delete(this.palette[slot]);
    this.free.push(slot);
    // Shrink once half the next narrower width would do, so a state added back does not widen it again at once.
    if (--this.live === 1 || widthFor(2 * this.live) < this.bits) this.compact();
  }
  // Drops unused slots, merges duplicate states and narrows the index width.
  private compact(): void {
    const { palette, counts, size } = this,
      remap = new Uint16Array(size),
      slots = new Map<number, number>();
    for (let s = 0; s < size; s++)
      if (counts[s]) {
        let t = slots.get(palette[s]);
        if (t === undefined) slots.set(palette[s], (t = slots.size));
        remap[s] = t;
      }
    const n = slots.size,
      bits = n === 1 ? 0 : (Math.min(this.bits, widthFor(2 * n)) as Bits),
      cap = capacity(bits);
    this.palette = new Uint32Array(cap);
    this.counts = new Uint16Array(cap);
    for (const [state, t] of slots) this.palette[t] = state;
    for (let s = 0; s < size; s++) if (counts[s]) this.counts[remap[s]] += counts[s];
    this.words = reencode(this.bits, this.words, bits, remap);
    this.size = this.live = n;
    this.free = [];
    this.bits = bits;
    this.lookup = cap > 16 ? slots : null;
  }
}
