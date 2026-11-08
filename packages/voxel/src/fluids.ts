// @margoengine/voxel/fluids: flowing liquids as a cellular automaton over the world's blocks. A liquid cell's state data
// holds its level: 0 a source (full), 1..7 flowing (the mesher lowers its top by that many eighths), 8 falling (full,
// fed from above). Each change schedules the cell and its six neighbours `delay` ticks later; a scheduled cell first
// settles its own level from its neighbours (a cell nobody feeds dries up), then flows down, or else sideways toward
// the nearest drop within `reach` cells. Rules follow the published descriptions of block-game liquids (see the
// package README); edits go through the world, so light, meshes and events follow.
import { MargoError } from '@margoengine/math/errors';
import { blockState } from './blocks.js';
import type { VoxelWorld } from './world.js';

/** One flowing liquid of a {@link VoxelFluids}. */
export interface VoxelFluid {
  /** The liquid's block type, by id or name (a `'liquid'` shape). */
  block: number | string;
  /** Cells it runs sideways from a source or a fall, 1 to 7. Default 7 (water); 3 is lava-like. */
  reach?: number;
  /** Ticks between its steps, an integer >= 1. Default 5 (water at 20 ticks a second); 30 is lava-like. */
  delay?: number;
  /** A flowing cell between two sources, on solid ground or a source, becomes a source. Default false. */
  infinite?: boolean;
}

/** Two liquids touching: the cell of `fluid` turns into a block. */
export interface VoxelFluidMix {
  /** The liquid whose cell turns, by id or name. */
  fluid: number | string;
  /** The liquid it touches (beside or above it), by id or name. */
  touches: number | string;
  /** What a source of `fluid` becomes (lava source and water: obsidian). */
  source: number | string;
  /** What a flowing cell of `fluid` becomes (flowing lava and water: cobblestone). */
  flowing: number | string;
}

/** Options of {@link VoxelFluids.attach}. */
export interface VoxelFluidsOptions {
  /** The liquids that flow. */
  fluids: readonly VoxelFluid[];
  /** Liquids turning to blocks where they meet. Default none. */
  mixes?: readonly VoxelFluidMix[];
  /** Ticks a second {@link VoxelFluids.update} advances by. Default 20. */
  ticksPerSecond?: number;
  /** Most cells one tick updates; the rest wait for the next tick. Default 65,536. */
  maxUpdates?: number;
}

/** Flags of a liquid's state data. */
export const FLUID_FALLING = 8;

const DIRS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

interface Fluid {
  id: number;
  step: number;
  delay: number;
  infinite: boolean;
  mixes: { touches: number; source: number; flowing: number }[];
}

const whole = (name: string, value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number') throw new TypeError(`VoxelFluids ${name} must be a number`);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`VoxelFluids ${name} is ${value}; pass an integer in ${min}..${max}`);
  return value;
};

/**
 * Water and lava that spread and fall: attach it to a world, call {@link VoxelFluids.update} every frame, and any
 * liquid block set in the world (a source) flows. Unloaded chunks and the world's y range stop it like rock.
 */
export class VoxelFluids {
  readonly world: VoxelWorld;
  #fluids = new Map<number, Fluid>();
  #due = new Map<string, number>(); // cell key -> tick it is due
  #buckets = new Map<number, string[]>();
  #tick = 0;
  #time = 0;
  #rate: number;
  #max: number;
  #off: () => void;
  #disposed = false;

  /**
   * Follows `world`'s edits: every change of a liquid cell or its neighbours schedules them.
   * @throws TypeError for a wrong world or option type; RangeError for an option out of range or a block that is not
   * defined (or a fluid that is not a `'liquid'` shape).
   */
  static attach(world: VoxelWorld, options: VoxelFluidsOptions): VoxelFluids {
    return new VoxelFluids(world, options);
  }

  private constructor(world: VoxelWorld, options: VoxelFluidsOptions) {
    if (typeof world?.onChange !== 'function' || typeof world.getBlock !== 'function')
      throw new TypeError('VoxelFluids.attach expects a VoxelWorld; pass new VoxelWorld({blocks})');
    if (!options || !Array.isArray(options.fluids))
      throw new TypeError('VoxelFluids options need fluids: [{block: "water"}, ...]');
    const { ticksPerSecond = 20, maxUpdates = 65536, mixes = [] } = options,
      table = world.blocks.table,
      id = (block: number | string, what: string): number => {
        const type = typeof block === 'string' ? table.find((t) => t.name === block) : table[block];
        if (typeof block !== 'string' && typeof block !== 'number')
          throw new TypeError(`VoxelFluids ${what} must be a block id or name`);
        if (!type)
          throw new RangeError(`VoxelFluids ${what} "${block}" is not a defined block; define it with blocks.define()`);
        return type.id;
      };
    if (typeof ticksPerSecond !== 'number') throw new TypeError('VoxelFluids ticksPerSecond must be a number');
    if (!(ticksPerSecond > 0 && ticksPerSecond <= 1000))
      throw new RangeError(`VoxelFluids ticksPerSecond is ${ticksPerSecond}; pass a number in (0, 1000]`);
    this.#rate = ticksPerSecond;
    this.#max = whole('maxUpdates', maxUpdates, 1, 2 ** 30);
    for (const fluid of options.fluids) {
      if (!fluid || typeof fluid !== 'object') throw new TypeError('VoxelFluids fluids must be objects {block}');
      const f = id(fluid.block, 'fluid block');
      if (table[f].shape !== 'liquid')
        throw new RangeError(`VoxelFluids fluid "${table[f].name}" is not a liquid; define it with shape: 'liquid'`);
      const reach = whole('reach', fluid.reach ?? 7, 1, 7);
      this.#fluids.set(f, {
        id: f,
        step: Math.floor(7 / reach),
        delay: whole('delay', fluid.delay ?? 5, 1, 1 << 20),
        infinite: !!fluid.infinite,
        mixes: [],
      });
    }
    if (!Array.isArray(mixes)) throw new TypeError('VoxelFluids mixes must be an array');
    for (const mix of mixes) {
      const f = this.#fluids.get(id(mix?.fluid, 'mix fluid'));
      if (!f) throw new RangeError('VoxelFluids mix fluid is not one of fluids; list it in fluids');
      f.mixes.push({
        touches: id(mix.touches, 'mix touches'),
        source: id(mix.source, 'mix source'),
        flowing: id(mix.flowing, 'mix flowing'),
      });
    }
    this.world = world;
    this.#off = world.onChange((x, y, z) => {
      this.#wake(x, y, z);
      this.#wake(x, y + 1, z);
      this.#wake(x, y - 1, z);
      for (const [dx, , dz] of DIRS) this.#wake(x + dx, y, z + dz);
    });
  }

  /** Cells waiting for their tick. */
  get pending(): number {
    return this.#due.size;
  }

  /** Ticks run so far. */
  get ticks(): number {
    return this.#tick;
  }

  // Schedules a liquid cell `delay` ticks from now, unless it is due sooner.
  #wake(x: number, y: number, z: number): void {
    const f = this.#fluids.get(this.world.getBlock(x, y, z) & 0xffff);
    if (!f) return;
    const key = `${x},${y},${z}`,
      at = this.#tick + f.delay,
      due = this.#due.get(key);
    if (due !== undefined && due <= at) return;
    this.#due.set(key, at);
    let bucket = this.#buckets.get(at);
    if (!bucket) this.#buckets.set(at, (bucket = []));
    bucket.push(key);
  }

  /**
   * Advances by `seconds` (whole ticks at `ticksPerSecond`; the rest carries over), at most 10 ticks a call.
   * Returns the cells updated.
   * @throws RangeError for negative or non-finite seconds; MargoError `disposed` after `dispose()`.
   */
  update(seconds: number): number {
    if (typeof seconds !== 'number' || !(seconds >= 0) || !Number.isFinite(seconds))
      throw new RangeError(`VoxelFluids.update seconds is ${seconds}; pass the frame's seconds, 0 or more`);
    this.#time = Math.min(this.#time + seconds * this.#rate, 10);
    let n = 0;
    while (this.#time >= 1) {
      this.#time--;
      n += this.tick();
    }
    return n;
  }

  /**
   * Runs one tick: every cell due now settles and flows. Returns the cells updated.
   * @throws MargoError `disposed` after `dispose()`.
   */
  tick(): number {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelFluids is disposed; attach a new one');
    const now = ++this.#tick,
      bucket = this.#buckets.get(now) ?? [];
    this.#buckets.delete(now);
    let n = 0;
    for (let i = 0; i < bucket.length; i++) {
      const key = bucket[i];
      if (this.#due.get(key) !== now) continue; // rescheduled sooner, already run
      if (n >= this.#max) {
        // Over the cap: the rest go to the next tick, in order.
        const rest = bucket.slice(i).filter((k) => this.#due.get(k) === now);
        for (const k of rest) this.#due.set(k, now + 1);
        this.#buckets.set(now + 1, [...rest, ...(this.#buckets.get(now + 1) ?? [])]);
        break;
      }
      this.#due.delete(key);
      const [x, y, z] = key.split(',').map(Number);
      this.#step(x, y, z);
      n++;
    }
    return n;
  }

  /**
   * Runs ticks until nothing is pending or `maxTicks` ran (a loading screen, a test). Returns the ticks run.
   * @throws RangeError for `maxTicks` that is not an integer >= 1.
   */
  settle(maxTicks = 100000): number {
    whole('maxTicks', maxTicks, 1, 2 ** 31);
    let ticks = 0;
    while (this.#due.size && ticks < maxTicks) {
      this.tick();
      ticks++;
    }
    return ticks;
  }

  // Can a liquid enter (x, y, z)? Air, or a block that is neither solid nor a liquid (plants wash away), in a loaded
  // chunk inside the world's y range.
  #open(x: number, y: number, z: number): boolean {
    const w = this.world;
    if (y < w.minY || y > w.maxY || !w.getChunk(x >> 5, y >> 5, z >> 5)) return false;
    const type = w.blocks.table[w.getBlock(x, y, z) & 0xffff];
    return !type || type.id === 0 || (!type.solid && !type.liquid);
  }

  // The cell's level as a feeder of f: 0 for a source or a fall, 1..7 flowing, Infinity when it is not f.
  #level(x: number, y: number, z: number, f: Fluid): number {
    const s = this.world.getBlock(x, y, z);
    if ((s & 0xffff) !== f.id) return Infinity;
    const data = s >>> 16;
    return data & FLUID_FALLING ? 0 : data & 7;
  }

  #set(x: number, y: number, z: number, state: number): void {
    if (this.world.getBlock(x, y, z) !== state) this.world.setBlock(x, y, z, state);
  }

  #step(x: number, y: number, z: number): void {
    const w = this.world,
      s = w.getBlock(x, y, z),
      f = this.#fluids.get(s & 0xffff);
    if (!f) return;
    const data = s >>> 16,
      source = data === 0;
    // Mixing: touching the other liquid beside or above turns the cell into a block.
    for (const mix of f.mixes)
      for (const [dx, dy, dz] of [...DIRS, [0, 1, 0]])
        if ((w.getBlock(x + dx, y + dy, z + dz) & 0xffff) === mix.touches)
          return void w.setBlock(x, y, z, source ? mix.source : mix.flowing);
    // Settle: what feeds this cell decides its level; nothing feeding it dries it up.
    let level = 0;
    if (!source) {
      let sources = 0,
        feed = Infinity;
      for (const [dx, , dz] of DIRS) {
        const l = this.#level(x + dx, y, z + dz, f);
        if (l === 0 && !((w.getBlock(x + dx, y, z + dz) >>> 16) & FLUID_FALLING)) sources++;
        feed = Math.min(feed, l);
      }
      const below = w.getBlock(x, y - 1, z),
        grounded = (below & 0xffff) === f.id ? below >>> 16 === 0 : !this.#open(x, y - 1, z);
      let want: number;
      if (f.infinite && sources >= 2 && grounded) want = blockState(f.id, 0);
      else if ((w.getBlock(x, y + 1, z) & 0xffff) === f.id) want = blockState(f.id, FLUID_FALLING);
      else if (feed + f.step <= 7) want = blockState(f.id, feed + f.step);
      else want = 0;
      if (want !== s) return void w.setBlock(x, y, z, want); // the change wakes this cell again
      level = data & FLUID_FALLING ? 0 : data & 7;
    }
    // Flow down if it can; else sideways, toward the nearest drop within reach.
    if (this.#open(x, y - 1, z)) return void this.#set(x, y - 1, z, blockState(f.id, FLUID_FALLING));
    // Sideways only from solid ground or a source below: a column falling into the liquid does not fan out.
    const below = this.world.getBlock(x, y - 1, z);
    if ((below & 0xffff) === f.id && below >>> 16 !== 0) return;
    const next = level + f.step;
    if (next > 7) return;
    const reach = Math.min(4, Math.floor(7 / f.step)),
      // Distances count through cells it already flows in, so a way taken stays the way to take.
      dist = DIRS.map(([dx, , dz]) =>
        this.#passes(x + dx, y, z + dz, f) ? this.#drop(x + dx, y, z + dz, dx, dz, reach, f) : Infinity,
      ),
      best = Math.min(...dist);
    DIRS.forEach(([dx, , dz], i) => {
      if (dist[i] === Infinity || (best < reach + 1 && dist[i] !== best)) return;
      if (this.#flows(x + dx, y, z + dz, f, next)) this.#set(x + dx, y, z + dz, blockState(f.id, next));
    });
  }

  // Can f flow into (x, y, z) at `level`: an open cell, or f flowing there at a higher level.
  #flows(x: number, y: number, z: number, f: Fluid, level: number): boolean {
    const s = this.world.getBlock(x, y, z);
    if ((s & 0xffff) === f.id) {
      const data = s >>> 16;
      return data !== 0 && !(data & FLUID_FALLING) && (data & 7) > level;
    }
    return this.#open(x, y, z);
  }

  // An open cell, or f flowing there (not a source).
  #passes(x: number, y: number, z: number, f: Fluid): boolean {
    const s = this.world.getBlock(x, y, z);
    return (s & 0xffff) === f.id ? s >>> 16 !== 0 : this.#open(x, y, z);
  }

  // Steps from (x, y, z), entered going (dx, dz), to the nearest cell with an open cell (or f falling) below, within
  // `reach`; reach + 1 when there is none. A breadth-first search over cells f passes that never turns back.
  #drop(x: number, y: number, z: number, dx: number, dz: number, reach: number, f: Fluid): number {
    let frontier = [[x, z, dx, dz]];
    const seen = new Set([`${x},${z}`]);
    for (let d = 0; d <= reach && frontier.length; d++) {
      const next: number[][] = [];
      for (const [cx, cz, fx, fz] of frontier) {
        if (this.#open(cx, y - 1, cz) || (this.world.getBlock(cx, y - 1, cz) & 0xffff) === f.id) return d;
        for (const [ex, , ez] of DIRS) {
          if (ex === -fx && ez === -fz) continue;
          const nx = cx + ex,
            nz = cz + ez,
            key = `${nx},${nz}`;
          if (seen.has(key) || !this.#passes(nx, y, nz, f)) continue;
          seen.add(key);
          next.push([nx, nz, ex, ez]);
        }
      }
      frontier = next;
    }
    return reach + 1;
  }

  /** Stops following the world and drops what is scheduled. The liquid stays as it is. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#off();
    this.#due.clear();
    this.#buckets.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
