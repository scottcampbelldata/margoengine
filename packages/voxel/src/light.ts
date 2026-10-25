/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/voxel/light: sky and block light by breadth-first flood fill, on the main thread with a per-call budget.
import { MargoError } from '@margoengine/math/errors';
import { slabOctants, stairOctants, WATERLOGGED } from './octants.js';
import { paletteOf, type VoxelChunk } from './chunk.js';
import { chunkKey, VoxelWorld } from './world.js';

/** Brightest light level: sky light under open sky, and the most a block type can emit. */
export const MAX_LIGHT = 15;

/** Options of {@link VoxelLighting.attach}. */
export interface VoxelLightingOptions {
  /** Most cells one {@link VoxelLighting.update} call processes (an integer >= 1, or Infinity). Default 4096. */
  budget?: number;
}

// A loaded chunk as the lighting knows it. Links: +x, -x, +y, -y, +z, -z neighbours (d ^ 1 is the opposite side).
interface Section {
  readonly chunk: VoxelChunk;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly links: (Section | undefined)[];
  removed: boolean;
  touched: number; // bit (dx + 1) + 3 (dy + 1) + 9 (dz + 1): chunks whose one-cell shell holds a changed light byte
  uniform: number; // the light byte of every cell while none has been written since its load, else -1
}

const NONE = -32768, // heightmap value of a column with no light-blocking cell
  CENTER = 1 << 13,
  EVERY = (1 << 27) - 1,
  SHIFT = [0, 10, 5], // index shift of x, y, z: cell i = x | z << 5 | y << 10
  // Pending edit flags (block light may always change): sky light may change (opacity changed) or fall (opacity
  // rose); block light may fall (opacity rose or emission fell).
  SKY = 1,
  SKY_FALLS = 2,
  BLOCK_FALLS = 4,
  // Block flags beyond opacity (0-3) and light (4-7): a slab or stair (8), a stair rather than a slab (9). state()
  // adds the faces its boxes cover whole at bits 10-15 (bit 10 + d for face d: +x, -x, +y, -y, +z, -z).
  PART = 256,
  STAIR = 512,
  UP = 1 << 12, // +y covered
  // Faces covered whole per octant mask: face d is covered when the 4 octants against it are filled.
  COVER = Uint8Array.from({ length: 256 }, (_, mask) => {
    let faces = 0;
    for (let d = 0; d < 6; d++) {
      const bit = 1 << (d >> 1),
        side = d & 1 ? 0 : bit;
      let all = true;
      for (let k = 0; k < 8; k++) if ((k & bit) === side && !((mask >> k) & 1)) all = false;
      if (all) faces |= 1 << d;
    }
    return faces;
  });
const attached = new WeakSet<VoxelWorld>();
const budgetOf = (value: unknown): number => {
  if (typeof value !== 'number') throw new TypeError('VoxelLighting budget must be a number; pass cells per update');
  if (!(value === Infinity || (Number.isInteger(value) && value >= 1)))
    throw new RangeError(`VoxelLighting budget ${value} is not an integer >= 1; pass cells per update or Infinity`);
  return value;
};
// Bits of `touched` for a light change at cell i: its chunk, plus each neighbour whose border shell holds the cell.
const shell = (i: number): number => {
  const x = i & 31,
    y = i >> 10,
    z = (i >> 5) & 31;
  if (x && x < 31 && y && y < 31 && z && z < 31) return CENTER;
  const side = (c: number) => (c ? (c === 31 ? 6 : 2) : 3); // bits of offsets -1, 0, +1
  const xs = side(x),
    ys = side(y),
    zs = side(z);
  let bits = 0;
  for (let a = 0; a < 3; a++)
    for (let b = 0; b < 3; b++)
      for (let c = 0; c < 3; c++) if ((xs >> a) & (ys >> b) & (zs >> c) & 1) bits |= 1 << (a + 3 * b + 9 * c);
  return bits;
};

/**
 * Sky and block light of a {@link VoxelWorld}, kept in its chunks' light bytes (sky light in the high nibble, block
 * light in the low). Sky light is {@link MAX_LIGHT} in every cell above its column's heightmap (the highest cell with
 * opacity > 0, or a slab or stair) and spreads from there; block light spreads from each block type's `light`. Each step
 * to a neighbour costs 1 plus the entered cell's `opacity`, across chunk borders. Slabs and stairs pass light through
 * their open part: light does not cross a face their boxes cover whole (a slab's bottom, a stair's back), and one whose
 * top is open is lit as open sky when it tops its column. Edits and chunk loads are queued as they happen and
 * {@link VoxelLighting.update} (call it once a frame) works through at most `budget` cells, so big changes spread over
 * frames. Chunks whose light changed, and loaded neighbours whose border shell holds a changed cell, go into
 * `world.dirty`. A removed chunk's cells keep their heights in the heightmap, so caves stay dark when the chunks above
 * them unload; light that reached other chunks through it goes.
 * Breadth-first flood fill (textbook); 4-bit levels 0-15 are a common block-game design choice.
 */
export class VoxelLighting {
  private readonly world: VoxelWorld;
  private limit: number;
  private flags = new Uint16Array(65536); // per block id: opacity | light << 4 | PART | STAIR
  private parts = false; // some block type is a slab or stair
  private wet = new Uint8Array(65536); // per slab or stair id: its waterlog liquid's opacity
  private types = 0;
  private disposed = false;
  private readonly sections = new Map<string, Section>();
  private readonly columns = new Map<string, Section[]>(); // loaded sections of a chunk column, highest first
  private readonly loads: [number, number, number, VoxelChunk | undefined][] = [];
  private loadHead = 0;
  private readonly edits: number[] = []; // x, y, z, flags
  private editHead = 0;
  // Add queue (cells whose light spreads) and removal queue (cell index | old level << 15 | block channel << 19).
  private readonly addS: Section[] = [];
  private readonly addI: number[] = [];
  private addHead = 0;
  private readonly cutS: Section[] = [];
  private readonly cutE: number[] = [];
  private cutHead = 0;
  private readonly touched: Section[] = [];
  private j = 0; // cell index out-parameter of near()
  private readonly offChange: () => void;
  private readonly offChunk: () => void;

  /**
   * Lights `world`: queues every loaded chunk now and each chunk load, removal and light-relevant edit from then on.
   * Light bytes already in added chunks are recomputed. Run {@link VoxelLighting.update} to apply the queue.
   * @throws TypeError when `world` is not a VoxelWorld or `budget` is not a number.
   * @throws RangeError when `budget` is not an integer >= 1 or Infinity.
   * @throws MargoError `'attached'` when another VoxelLighting lights `world`.
   */
  static attach(world: VoxelWorld, options: VoxelLightingOptions = {}): VoxelLighting {
    return new VoxelLighting(world, options);
  }
  private constructor(world: VoxelWorld, options: VoxelLightingOptions) {
    if (!(world instanceof VoxelWorld))
      throw new TypeError('VoxelLighting.attach expects a VoxelWorld; pass new VoxelWorld({blocks})');
    if (!options || typeof options !== 'object') throw new TypeError('VoxelLighting options must be an object');
    this.limit = budgetOf(options.budget ?? 4096);
    if (attached.has(world))
      throw new MargoError('attached', 'VoxelWorld already has a VoxelLighting; dispose() it before attaching another');
    attached.add(world);
    this.world = world;
    this.refresh();
    this.offChunk = world.onChunk((cx, cy, cz, chunk) => {
      this.loads.push([cx, cy, cz, chunk]);
    });
    this.offChange = world.onChange((x, y, z, state, previous) => {
      if (this.types !== world.blocks.table.length) this.refresh();
      const now = this.flags[state & 0xffff],
        was = this.flags[previous & 0xffff];
      // A slab or stair before or after (or turned) may open or close any face: everything is checked again.
      if ((now | was) & PART && state !== previous) return void this.edits.push(x, y, z, SKY | SKY_FALLS | BLOCK_FALLS);
      if (now === was) return;
      const opacity = (now & 15) - (was & 15);
      this.edits.push(
        x,
        y,
        z,
        (opacity ? SKY : 0) | (opacity > 0 ? SKY_FALLS | BLOCK_FALLS : 0) | (now >> 4 < was >> 4 ? BLOCK_FALLS : 0),
      );
    });
  }
  /**
   * Most cells one {@link VoxelLighting.update} call processes: an integer >= 1, or Infinity to finish every queued
   * change in one call. A chunk load is never split; it counts the cells it lights plus an eighth of those it scans
   * (about 130 for open sky beside open sky, up to about 13,000 for mixed blocks with emitters). Raise it while a
   * loading screen is up.
   * @throws TypeError for a non-number. @throws RangeError unless it is an integer >= 1 or Infinity.
   */
  get budget(): number {
    return this.limit;
  }
  set budget(value: number) {
    this.limit = budgetOf(value);
  }
  /**
   * Sky light (0-15) of cell (x, y, z). An unloaded cell reads {@link MAX_LIGHT} above its column's heightmap (or in
   * a column with no loaded chunk) and 0 below it.
   * @throws RangeError (TypeError for non-numbers) when a coordinate is not a 32-bit integer.
   */
  skyLight(x: number, y: number, z: number): number {
    const chunk = this.chunkAt(x, y, z);
    if (chunk) return chunk.getLight(x & 31, y & 31, z & 31) >> 4;
    const heights = this.world.heightmap(x >> 5, z >> 5);
    return heights && y <= heights[(x & 31) | ((z & 31) << 5)] ? 0 : MAX_LIGHT;
  }
  /**
   * Block light (0-15) of cell (x, y, z); 0 for an unloaded cell.
   * @throws RangeError (TypeError for non-numbers) when a coordinate is not a 32-bit integer.
   */
  blockLight(x: number, y: number, z: number): number {
    const chunk = this.chunkAt(x, y, z);
    return chunk ? chunk.getLight(x & 31, y & 31, z & 31) & 15 : 0;
  }
  /**
   * Applies queued chunk loads and removals, then edits, then spreads and removes light, stopping once `budget`
   * cells are processed; marks the chunks whose light changed in `world.dirty`. Call it once a frame. Returns the
   * cells processed: 0 when the light is up to date.
   * @throws MargoError `'disposed'` after {@link VoxelLighting.dispose}.
   */
  update(): number {
    if (this.disposed)
      throw new MargoError('disposed', 'VoxelLighting is disposed; attach a new one with VoxelLighting.attach(world)');
    if (this.types !== this.world.blocks.table.length) this.refresh();
    const { limit, loads, edits } = this;
    let done = 0;
    while (done < limit && this.loadHead < loads.length) done += this.load(loads[this.loadHead++]);
    if (this.loadHead === loads.length) {
      loads.length = this.loadHead = 0;
      for (; done < limit && this.editHead < edits.length; this.editHead += 4) {
        const h = this.editHead;
        done += this.edit(edits[h], edits[h + 1], edits[h + 2], edits[h + 3]);
      }
      if (this.editHead === edits.length) {
        edits.length = this.editHead = 0;
        // Removal first: spreading must not build on light a removal is about to take away.
        for (; done < limit && this.cutHead < this.cutE.length; done++) this.unspread();
        if (this.cutHead === this.cutE.length) {
          this.cutS.length = this.cutE.length = this.cutHead = 0;
          for (; done < limit && this.addHead < this.addI.length; done++) this.spread();
          if (this.addHead === this.addI.length) this.addS.length = this.addI.length = this.addHead = 0;
        }
      }
    }
    this.flush();
    return done;
  }
  /** Stops following the world's changes and drops queued work; the light bytes stay as they are. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offChange();
    this.offChunk();
    attached.delete(this.world);
    this.loads.length = this.edits.length = this.addI.length = this.addS.length = this.cutE.length = 0;
    this.cutS.length = this.touched.length = 0;
    this.sections.clear();
    this.columns.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private chunkAt(x: number, y: number, z: number): VoxelChunk | undefined {
    if ((x | 0) !== x || (y | 0) !== y || (z | 0) !== z)
      throw [x, y, z].every((v) => typeof v === 'number')
        ? new RangeError(`Cell (${x}, ${y}, ${z}) is not three 32-bit integers; floor positions to cells first`)
        : new TypeError('Cell coordinates must be numbers');
    return this.world.getChunk(x >> 5, y >> 5, z >> 5);
  }
  private refresh(): void {
    const table = this.world.blocks.table;
    for (const type of table) {
      const part = type.shape === 'slab' ? PART : type.shape === 'stair' ? PART | STAIR : 0;
      this.flags[type.id] = type.opacity | (type.light << 4) | part;
      this.wet[type.id] = type.waterlog ? (table[type.waterlog]?.opacity ?? 0) : 0;
      if (part) this.parts = true;
    }
    this.types = table.length;
  }
  // Flags of cell i of s; for a slab or stair with its whole-covered faces at bits 10-15.
  // A waterlogged one costs its liquid's opacity when that is more.
  private state(s: Section, i: number): number {
    const state = s.chunk.get(i & 31, i >> 10, (i >> 5) & 31),
      f = this.flags[state & 0xffff];
    if (!(f & PART)) return f;
    const data = state >>> 16,
      opacity = data & WATERLOGGED ? Math.max(f & 15, this.wet[state & 0xffff]) : f & 15;
    return (f & ~15) | opacity | (COVER[f & STAIR ? stairOctants(data) : slabOctants(data)] << 10);
  }
  // Whether light cannot cross between cell i of s (flags `f`) and its neighbour j of t (flags `g`) across face d of i.
  private shut(f: number, g: number, d: number): boolean {
    return ((f >> (10 + d)) & 1) === 1 || ((g >> (10 + (d ^ 1))) & 1) === 1;
  }
  // The column top (heightmap cell) of a slab or stair with an open top is lit as open sky.
  private top(s: Section, i: number, f: number): void {
    if (!(f & PART) || f & UP) return;
    this.put(s, i, 0xf0 | (this.light(s, i) & 15));
    this.push(s, i);
  }
  // The heightmap cell y of column cell k goes under a new top: an open-topped slab or stair there loses its sky light.
  private cover(column: Section[], k: number, y: number): void {
    if (!this.parts || y === NONE) return;
    for (const s of column)
      if (y >> 5 === s.cy) {
        const i = k | ((y & 31) << 10);
        if (this.state(s, i) & PART) this.clear(s, i, 0);
      }
  }
  private light(s: Section, i: number): number {
    return s.chunk.getLight(i & 31, i >> 10, (i >> 5) & 31);
  }
  private put(s: Section, i: number, byte: number): void {
    s.chunk.setLight(i & 31, i >> 10, (i >> 5) & 31, byte);
    s.uniform = -1;
    if (!s.touched) this.touched.push(s);
    s.touched |= shell(i);
  }
  private push(s: Section, i: number): void {
    this.addS.push(s);
    this.addI.push(i);
  }
  private cut(s: Section, i: number, block: number, level: number): void {
    this.cutS.push(s);
    this.cutE.push(i | (level << 15) | (block << 19));
  }
  // The section holding neighbour d of cell i of s (its index in this.j), or undefined when that chunk is not loaded.
  private near(s: Section, i: number, d: number): Section | undefined {
    const shift = SHIFT[d >> 1],
      c = (i >> shift) & 31;
    if (d & 1) {
      if (c) {
        this.j = i - (1 << shift);
        return s;
      }
      this.j = i + (31 << shift);
    } else {
      if (c < 31) {
        this.j = i + (1 << shift);
        return s;
      }
      this.j = i - (31 << shift);
    }
    return s.links[d];
  }
  // Raises cell j of t to what light byte `from` gives it, entering through j's face `enter`; queues it when either
  // channel rose.
  private relax(from: number, t: Section, j: number, enter: number): void {
    const to = this.light(t, j);
    // Most steps lead back toward brighter cells: rule them out before reading the block state.
    if ((from >> 4) - 1 <= to >> 4 && (from & 15) - 1 <= (to & 15)) return;
    const f = this.state(t, j);
    if ((f >> (10 + enter)) & 1) return; // a face its boxes cover whole
    const opacity = f & 15,
      sky = (from >> 4) - 1 - opacity,
      block = (from & 15) - 1 - opacity;
    if (sky > to >> 4 || block > (to & 15)) {
      this.put(t, j, (Math.max(sky, to >> 4) << 4) | Math.max(block, to & 15));
      this.push(t, j);
    }
  }
  private spread(): void {
    const h = this.addHead++,
      s = this.addS[h],
      i = this.addI[h];
    if (s.removed) return;
    const from = this.light(s, i);
    if (from >> 4 <= 1 && (from & 15) <= 1) return;
    const shut = this.parts ? this.state(s, i) >> 10 : 0;
    for (let d = 0; d < 6; d++) {
      const t = (shut >> d) & 1 ? undefined : this.near(s, i, d);
      if (t) this.relax(from, t, this.j, d ^ 1);
    }
  }
  // The two-queue removal of Ben Arnold, "Fast Flood Fill Lighting in a Blocky Voxel Game: Pt 1" (Seed of Andromeda
  // dev blog, seedofandromeda.com/blogs/29, offline now; 0fps.net/2018/02/21/voxel-lighting lists it): a neighbour
  // dimmer than the removed level may have been lit through the cell,
  // so it is cleared and queued for removal in turn; a neighbour at least as bright is lit some other way and is
  // queued to spread again. Here an emitting neighbour keeps its own light and a removed chunk's queued cells reach
  // only into loaded chunks.
  private unspread(): void {
    const h = this.cutHead++,
      s = this.cutS[h],
      e = this.cutE[h],
      i = e & 32767,
      level = (e >> 15) & 15,
      block = e >> 19,
      f = this.parts && !s.removed ? this.state(s, i) : 0;
    for (let d = 0; d < 6; d++) {
      const t = this.near(s, i, d);
      if (!t || t.removed) continue;
      const j = this.j,
        byte = this.light(t, j),
        v = block ? byte & 15 : byte >> 4;
      if (!v) continue;
      const g = this.state(t, j);
      if (this.parts && this.shut(f, g, d)) continue; // no light passed that way
      const own = block ? (g >> 4) & 15 : 0;
      if (v < level && own < v) {
        this.put(t, j, block ? (byte & 0xf0) | own : byte & 15);
        this.cut(t, j, block, v);
        if (own) this.push(t, j);
      } else if (!s.removed) this.push(t, j);
    }
  }
  // Clears one channel of cell i of s and queues its removal.
  private clear(s: Section, i: number, block: number): void {
    const byte = this.light(s, i),
      v = block ? byte & 15 : byte >> 4;
    if (!v) return;
    this.put(s, i, block ? byte & 0xf0 : byte & 15);
    this.cut(s, i, block, v);
  }
  // Queues the loaded neighbours of cell i of s to spread into it.
  private pull(s: Section, i: number): void {
    for (let d = 0; d < 6; d++) {
      const t = this.near(s, i, d);
      if (t) this.push(t, this.j);
    }
  }
  // Column cell k loses open sky from y = from to `to`: clears and queues the sky light of its loaded cells there.
  private shade(column: Section[], k: number, from: number, to: number): number {
    let cost = 0;
    for (const s of column) {
      const lo = Math.max(from, s.cy << 5),
        hi = Math.min(to, (s.cy << 5) + 31);
      for (let y = lo; y <= hi; y++, cost++) this.clear(s, k | ((y & 31) << 10), 0);
    }
    return cost;
  }
  // Column cell k is open from y = from down to its next light-blocking loaded cell, which becomes its height.
  private open(column: Section[], heights: Int16Array, k: number, from: number): number {
    let cost = 0;
    for (const s of column) {
      const y0 = s.cy << 5;
      if (y0 > from) continue;
      for (let y = Math.min(from, y0 + 31); y >= y0; y--, cost++) {
        const i = k | ((y & 31) << 10),
          f = this.state(s, i);
        if (f & (15 | PART)) {
          heights[k] = y;
          this.top(s, i, f);
          return cost;
        }
        this.put(s, i, 0xf0 | (this.light(s, i) & 15));
        this.push(s, i);
      }
    }
    heights[k] = NONE;
    return cost;
  }
  private edit(x: number, y: number, z: number, flags: number): number {
    const cx = x >> 5,
      cz = z >> 5,
      s = this.sections.get(chunkKey(cx, y >> 5, cz));
    if (!s) return 1;
    const i = (x & 31) | ((z & 31) << 5) | ((y & 31) << 10),
      f = this.state(s, i);
    let cost = 1;
    if (flags & SKY) {
      const heights = this.world.heightmap(cx, cz) as Int16Array,
        column = this.columns.get(`${cx},${cz}`) as Section[],
        k = i & 1023,
        h = heights[k];
      if (f & (15 | PART) && y > h) {
        this.cover(column, k, h);
        cost += this.shade(column, k, h + 1, y);
        heights[k] = y;
      } else if (!(f & (15 | PART)) && y === h) cost += this.open(column, heights, k, y);
      else if (y <= h && flags & SKY_FALLS) this.clear(s, i, 0);
      if (y === heights[k]) this.top(s, i, f);
    }
    if (flags & BLOCK_FALLS) this.clear(s, i, 1);
    this.pull(s, i); // light that may now enter the cell
    const byte = this.light(s, i);
    if (((f >> 4) & 15) > (byte & 15)) {
      this.put(s, i, (byte & 0xf0) | ((f >> 4) & 15));
      this.push(s, i);
    }
    return cost;
  }
  private load([cx, cy, cz, chunk]: [number, number, number, VoxelChunk | undefined]): number {
    const key = chunkKey(cx, cy, cz);
    if (!chunk) return this.unload(key);
    if (this.world.getChunk(cx, cy, cz) !== chunk) return 1; // removed again since
    const { flags } = this,
      heights = this.world.heightmap(cx, cz) as Int16Array,
      columnKey = `${cx},${cz}`,
      column = this.columns.get(columnKey) ?? [],
      y0 = cy << 5,
      y1 = y0 + 31;
    chunk.fillLight(0);
    // Cost in spread-cell units: reading or writing one cell of a scan is about an eighth of spreading from one.
    let blocking = false,
      emitting = false,
      cost = 1,
      scanned = 1024; // the column pass
    for (const state of paletteOf(chunk)) {
      blocking ||= (flags[state & 0xffff] & (15 | PART)) > 0;
      emitting ||= (flags[state & 0xffff] & 0xf0) > 0;
    }
    // Heights: the chunk decides its own range; above it they only rise, which shades the loaded cells below.
    for (let k = 0; k < 1024; k++) {
      let top = NONE;
      if (blocking)
        for (let y = 31; y >= 0; y--, scanned++)
          if (flags[chunk.get(k & 31, y, k >> 5) & 0xffff] & (15 | PART)) {
            top = y0 + y;
            break;
          }
      const h = heights[k];
      if (h > y1) continue;
      if (h >= y0) {
        if (top !== NONE) heights[k] = top;
        else cost += this.open(column, heights, k, y0 - 1);
      } else if (top !== NONE) {
        this.cover(column, k, h);
        cost += this.shade(column, k, h + 1, y0 - 1);
        heights[k] = top;
      }
    }
    const s: Section = { chunk, cx, cy, cz, links: [], removed: false, touched: 0, uniform: -1 };
    this.sections.set(key, s);
    let at = 0;
    while (at < column.length && column[at].cy > cy) at++;
    column.splice(at, 0, s);
    this.columns.set(columnKey, column);
    for (let d = 0; d < 6; d++) {
      const step = d & 1 ? -1 : 1,
        t = this.sections.get(
          chunkKey(cx + (d < 2 ? step : 0), cy + (d >> 1 === 1 ? step : 0), cz + (d > 3 ? step : 0)),
        );
      s.links[d] = t;
      if (t) t.links[d ^ 1] = s;
    }
    // Open sky, then the cells next to it that it lights: the lowest open cell of a column and open cells beside a
    // shaded neighbour column. A chunk entirely under open sky keeps a single light byte.
    const low = (k: number) => Math.min(32, Math.max(0, heights[k] + 1 - y0)); // lowest open local y; 32: none
    let open = true,
      dark = true;
    for (let k = 0; k < 1024; k++) {
      open &&= low(k) === 0;
      dark &&= low(k) === 32;
    }
    chunk.fillLight(open ? 0xf0 : 0);
    s.uniform = open ? 0xf0 : dark ? 0 : -1;
    if (!open)
      for (let k = 0; k < 1024; k++) {
        const lo = low(k),
          x = k & 31,
          z = k >> 5;
        for (let y = lo; y < 32; y++, scanned++) chunk.setLight(x, y, z, 0xf0);
        // An open-topped slab or stair topping the column here is lit as open sky too.
        if (this.parts && lo && heights[k] === y0 + lo - 1)
          this.top(s, k | ((lo - 1) << 10), this.state(s, k | ((lo - 1) << 10)));
        if (lo > 31) continue;
        if (lo) this.push(s, k | (lo << 10));
        for (const n of [x < 31 ? k + 1 : -1, x ? k - 1 : -1, z < 31 ? k + 32 : -1, z ? k - 32 : -1])
          if (n >= 0) for (let y = lo; y < low(n); y++) this.push(s, k | (y << 10));
      }
    if (emitting)
      for (let i = 0; i < 32768; i++, scanned++) {
        const own = (this.state(s, i) >> 4) & 15;
        if (own) {
          this.put(s, i, (this.light(s, i) & 0xf0) | own);
          this.push(s, i);
        }
      }
    // Borders: light flows both ways between the chunk and each loaded neighbour.
    for (let d = 0; d < 6; d++) {
      const t = s.links[d];
      if (!t || (s.uniform >= 0 && t.uniform === s.uniform)) continue; // e.g. open sky beside open sky
      const shift = SHIFT[d >> 1],
        [u, v] = SHIFT.filter((other) => other !== shift),
        here = d & 1 ? 0 : 31 << shift,
        there = d & 1 ? 31 << shift : 0;
      for (let a = 0; a < 32; a++)
        for (let b = 0; b < 32; b++) {
          const cell = (a << u) | (b << v);
          // Light leaves a slab or stair only through a face it leaves open.
          const out = this.parts ? (this.state(t, cell | there) >> 10) & (1 << (d ^ 1)) : 0,
            back = this.parts ? (this.state(s, cell | here) >> 10) & (1 << d) : 0;
          if (!out) this.relax(this.light(t, cell | there), s, cell | here, d);
          if (!back) this.relax(this.light(s, cell | here), t, cell | there, d ^ 1);
        }
      scanned += 2048;
    }
    if (!s.touched) this.touched.push(s);
    s.touched = EVERY;
    return cost + (scanned >> 3);
  }
  private unload(key: string): number {
    const s = this.sections.get(key);
    if (!s) return 1;
    this.sections.delete(key);
    s.removed = true;
    const columnKey = `${s.cx},${s.cz}`,
      column = this.columns.get(columnKey) as Section[];
    column.splice(column.indexOf(s), 1);
    if (!column.length) this.columns.delete(columnKey);
    // Light that crossed into a neighbour from here goes: queue the border cells' removal (they reach only out).
    let cost = 1;
    for (let d = 0; d < 6; d++) {
      const t = s.links[d];
      if (!t) continue;
      t.links[d ^ 1] = undefined;
      const shift = SHIFT[d >> 1],
        [u, v] = SHIFT.filter((other) => other !== shift),
        here = d & 1 ? 0 : 31 << shift;
      for (let a = 0; a < 32; a++)
        for (let b = 0; b < 32; b++) {
          const i = (a << u) | (b << v) | here,
            byte = this.light(s, i);
          if (byte >> 4) this.cut(s, i, 0, byte >> 4);
          if (byte & 15) this.cut(s, i, 1, byte & 15);
        }
      cost += 128; // 1,024 cells read
    }
    return cost;
  }
  // Adds each touched chunk, and its loaded neighbours whose border shell changed, to world.dirty.
  private flush(): void {
    for (const s of this.touched) {
      for (let b = 0; b < 27; b++)
        if (!s.removed && (s.touched >> b) & 1) {
          const key = chunkKey(s.cx + (b % 3) - 1, s.cy + (((b / 3) | 0) % 3) - 1, s.cz + ((b / 9) | 0) - 1);
          if (this.sections.has(key)) this.world.dirty.add(key);
        }
      s.touched = 0;
    }
    this.touched.length = 0;
  }
}
