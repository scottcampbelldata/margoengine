// @margoengine/voxel/ticks: block updates on a fixed tick. Random ticks pick `randomTicks` cells per loaded chunk per
// tick (growth, spread, decay); scheduled ticks run a cell's rule at a set tick (falling sand, fire burning out);
// neighbour updates run a cell's rule when a block beside it changes. Rules are plain functions keyed by block type;
// the built-in ones (falling, spreading, growing, fire) are made from the same three hooks. Deterministic for a seed.
import { MargoError } from '@margoengine/math/errors';
import { blockState } from './blocks.js';
import type { VoxelWorld } from './world.js';

/** What a {@link VoxelTickRule} hook gets: the cell, its state, and the ticker's random numbers and schedule. */
export interface VoxelTickContext {
  readonly world: VoxelWorld;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The cell's state when the hook runs. */
  readonly state: number;
  /** The tick number. */
  readonly tick: number;
  /** A number in [0, 1) from the ticker's seeded generator. */
  random(): number;
  /** Runs this cell's `scheduled` hook `delay` ticks from now (an integer >= 1). */
  schedule(delay: number): void;
}

/** The hooks of one block type; any may be left out. */
export interface VoxelTickRule {
  /** A random tick picked this cell. */
  random?(context: VoxelTickContext): void;
  /** A tick this cell asked for (or another rule asked for at it) came. */
  scheduled?(context: VoxelTickContext): void;
  /** A block beside this cell (one of six) changed. */
  neighbor?(context: VoxelTickContext): void;
  /** This cell changed (it was set to this block, or its data changed). */
  placed?(context: VoxelTickContext): void;
}

/** Options of {@link VoxelTicks.attach}. */
export interface VoxelTicksOptions {
  /** Rules by block type id or name. More with {@link VoxelTicks.rule}. */
  rules?: Readonly<Record<string, VoxelTickRule>>;
  /** Cells picked per loaded chunk per tick for random ticks, an integer 0..4096. Default 24 (3 per 16-cubed). */
  randomTicks?: number;
  /** Ticks a second {@link VoxelTicks.update} advances by. Default 20. */
  ticksPerSecond?: number;
  /** Seed of the random ticks and `random()`, an integer. Default 1. */
  seed?: number;
  /** Most scheduled and neighbour updates a tick; the rest wait for the next. Default 65,536. */
  maxUpdates?: number;
}

const whole = (name: string, value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number') throw new TypeError(`VoxelTicks ${name} must be a number`);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`VoxelTicks ${name} is ${value}; pass an integer in ${min}..${max}`);
  return value;
};
const SIDES = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

/**
 * Random, scheduled and neighbour block updates for a world. Attach it, give block types rules, and call
 * {@link VoxelTicks.update} every frame (or {@link VoxelTicks.tick} for one tick).
 */
export class VoxelTicks {
  readonly world: VoxelWorld;
  #rules = new Map<number, VoxelTickRule>();
  #chunks = new Map<string, [number, number, number]>();
  #scheduled = new Map<number, number[]>(); // tick -> x, y, z per entry
  #neighbors: number[] = []; // x, y, z, kind (0 a neighbour changed, 1 the cell changed) to run this or next tick
  #pendingScheduled = 0;
  #tick = 0;
  #time = 0;
  #seed: number;
  #rate: number;
  #randomTicks: number;
  #max: number;
  #off: (() => void)[];
  #disposed = false;

  /**
   * @throws TypeError for a wrong world or option type; RangeError for options out of range or a rule for a block
   * that is not defined.
   */
  static attach(world: VoxelWorld, options: VoxelTicksOptions = {}): VoxelTicks {
    return new VoxelTicks(world, options);
  }

  private constructor(world: VoxelWorld, options: VoxelTicksOptions) {
    if (typeof world?.onChange !== 'function' || typeof world.onChunk !== 'function')
      throw new TypeError('VoxelTicks.attach expects a VoxelWorld; pass new VoxelWorld({blocks})');
    if (!options || typeof options !== 'object') throw new TypeError('VoxelTicks options must be an object');
    const { rules = {}, randomTicks = 24, ticksPerSecond = 20, seed = 1, maxUpdates = 65536 } = options;
    this.#randomTicks = whole('randomTicks', randomTicks, 0, 4096);
    this.#seed = whole('seed', seed, -(2 ** 31), 2 ** 31 - 1) | 0 || 1;
    if (typeof ticksPerSecond !== 'number') throw new TypeError('VoxelTicks ticksPerSecond must be a number');
    if (!(ticksPerSecond > 0 && ticksPerSecond <= 1000))
      throw new RangeError(`VoxelTicks ticksPerSecond is ${ticksPerSecond}; pass a number in (0, 1000]`);
    this.#rate = ticksPerSecond;
    this.#max = whole('maxUpdates', maxUpdates, 1, 2 ** 30);
    this.world = world;
    for (const [block, rule] of Object.entries(rules)) this.rule(/^\d+$/.test(block) ? Number(block) : block, rule);
    this.#off = [
      world.onChunk((cx, cy, cz, chunk) => {
        const key = `${cx},${cy},${cz}`;
        if (chunk) this.#chunks.set(key, [cx, cy, cz]);
        else this.#chunks.delete(key);
      }),
      world.onChange((x, y, z) => {
        this.#neighbors.push(x, y, z, 1);
        for (const [dx, dy, dz] of SIDES) this.#neighbors.push(x + dx, y + dy, z + dz, 0);
      }),
    ];
  }

  /**
   * Sets (or with `undefined` removes) the rule of a block type.
   * @throws RangeError for a block that is not defined; TypeError for a rule that is not an object of functions.
   */
  rule(block: number | string, rule: VoxelTickRule | undefined): void {
    const table = this.world.blocks.table,
      type = typeof block === 'string' ? table.find((t) => t.name === block) : table[block];
    if (!type) throw new RangeError(`VoxelTicks rule block "${block}" is not defined; define it with blocks.define()`);
    if (rule === undefined) return void this.#rules.delete(type.id);
    if (
      !rule ||
      typeof rule !== 'object' ||
      (['random', 'scheduled', 'neighbor', 'placed'] as const).some(
        (k) => rule[k] !== undefined && typeof rule[k] !== 'function',
      )
    )
      throw new TypeError('VoxelTicks rule must be {random?, scheduled?, neighbor?, placed?} functions');
    this.#rules.set(type.id, rule);
  }

  /** Ticks run so far. */
  get ticks(): number {
    return this.#tick;
  }

  /** Scheduled updates waiting, plus neighbour updates not yet run. */
  get pending(): number {
    return this.#pendingScheduled + this.#neighbors.length / 4;
  }

  /**
   * Runs the `scheduled` hook of the block at (x, y, z) `delay` ticks from now.
   * @throws RangeError for a cell or delay that is not an integer (delay >= 1).
   */
  schedule(x: number, y: number, z: number, delay: number): void {
    if (![x, y, z].every(Number.isInteger)) throw new RangeError('VoxelTicks.schedule cell must be integers x, y, z');
    whole('delay', delay, 1, 2 ** 30);
    const at = this.#tick + delay;
    let list = this.#scheduled.get(at);
    if (!list) this.#scheduled.set(at, (list = []));
    list.push(x, y, z);
    this.#pendingScheduled++;
  }

  // Mulberry32 (Tommy Ettinger's public-domain 32-bit generator).
  #random = (): number => {
    let t = (this.#seed = (this.#seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  #run(x: number, y: number, z: number, hook: keyof VoxelTickRule): void {
    const state = this.world.getBlock(x, y, z),
      rule = this.#rules.get(state & 0xffff);
    const fn = rule?.[hook];
    if (!fn) return;
    fn.call(rule, {
      world: this.world,
      x,
      y,
      z,
      state,
      tick: this.#tick,
      random: this.#random,
      schedule: (delay: number) => this.schedule(x, y, z, delay),
    });
  }

  /**
   * Advances by `seconds` (whole ticks at `ticksPerSecond`; the rest carries over), at most 10 ticks a call. Returns
   * the ticks run.
   * @throws RangeError for negative or non-finite seconds; MargoError `disposed` after `dispose()`.
   */
  update(seconds: number): number {
    if (typeof seconds !== 'number' || !(seconds >= 0) || !Number.isFinite(seconds))
      throw new RangeError(`VoxelTicks.update seconds is ${seconds}; pass the frame's seconds, 0 or more`);
    this.#time = Math.min(this.#time + seconds * this.#rate, 10);
    let n = 0;
    for (; this.#time >= 1; this.#time--, n++) this.tick();
    return n;
  }

  /**
   * One tick: the scheduled updates due, then the random ticks of every loaded chunk (chunks in load order), then the
   * `placed` and `neighbor` hooks of every change so far (changes they make run next tick). Up to `maxUpdates` scheduled and
   * neighbour updates; the rest wait.
   * @throws MargoError `disposed` after `dispose()`; errors of rules propagate.
   */
  tick(): void {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelTicks is disposed; attach a new one');
    const now = ++this.#tick;
    let budget = this.#max;
    const due = this.#scheduled.get(now);
    if (due) {
      this.#scheduled.delete(now);
      let i = 0;
      for (; i < due.length && budget > 0; i += 3, budget--) {
        this.#pendingScheduled--;
        this.#run(due[i], due[i + 1], due[i + 2], 'scheduled');
      }
      if (i < due.length) this.#scheduled.set(now + 1, [...due.slice(i), ...(this.#scheduled.get(now + 1) ?? [])]);
    }
    if (this.#randomTicks && this.#rules.size)
      for (const [cx, cy, cz] of [...this.#chunks.values()])
        for (let k = 0; k < this.#randomTicks; k++) {
          const cell = (this.#random() * 32768) | 0;
          this.#run(cx * 32 + (cell & 31), cy * 32 + (cell >> 10), cz * 32 + ((cell >> 5) & 31), 'random');
        }
    const list = this.#neighbors;
    this.#neighbors = [];
    let i = 0;
    for (; i < list.length && budget > 0; i += 4, budget--)
      this.#run(list[i], list[i + 1], list[i + 2], list[i + 3] ? 'placed' : 'neighbor');
    if (i < list.length) this.#neighbors = list.slice(i).concat(this.#neighbors);
  }

  /** Stops following the world and drops what is scheduled. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const off of this.#off) off();
    this.#scheduled.clear();
    this.#neighbors = [];
    this.#pendingScheduled = 0;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/**
 * Falling blocks (sand, gravel): a block with an open cell below (air, or neither solid nor liquid) falls one cell
 * every `delay` ticks once a neighbour changes, until it lands; whatever it falls through is replaced.
 */
export function fallingRule(delay = 2): VoxelTickRule {
  whole('falling delay', delay, 1, 2 ** 20);
  const open = (c: VoxelTickContext, y: number): boolean => {
    const type = c.world.blocks.table[c.world.getBlock(c.x, y, c.z) & 0xffff];
    return y >= c.world.minY && !!c.world.getChunk(c.x >> 5, y >> 5, c.z >> 5) && (!type?.solid || type.id === 0);
  };
  const wake = (c: VoxelTickContext): void => {
    if (open(c, c.y - 1)) c.schedule(delay);
  };
  return {
    neighbor: wake,
    placed: wake,
    scheduled: (c) => {
      if (!open(c, c.y - 1)) return;
      c.world.setBlock(c.x, c.y, c.z, 0);
      c.world.setBlock(c.x, c.y - 1, c.z, c.state);
      // The block now below schedules itself through its neighbour update.
    },
  };
}

/** Options of {@link spreadRule}. */
export interface SpreadRuleOptions {
  /** The block it spreads onto, by id. */
  onto: number;
  /** Chance per random tick, 0..1. Default 1. */
  chance?: number;
  /** Least sky light (high 4 bits of the light byte) of the cell above the target, 0..15. Default 0. */
  light?: number;
  /** What the block turns into when a solid block covers it (grass under stone becomes dirt), by id. Default none. */
  smothered?: number;
}

/**
 * A block that spreads onto `onto` blocks within one cell sideways and one up or down (grass onto dirt, moss onto
 * stone) on random ticks, where the cell above the target is not solid and lit enough.
 */
export function spreadRule(options: SpreadRuleOptions): VoxelTickRule {
  if (!options || typeof options !== 'object') throw new TypeError('spreadRule options must be {onto}');
  const { onto, chance = 1, light = 0, smothered } = options;
  whole('spread onto', onto, 0, 0xffff);
  if (!(chance >= 0 && chance <= 1)) throw new RangeError(`spreadRule chance is ${chance}; pass 0..1`);
  whole('spread light', light, 0, 15);
  const lit = (c: VoxelTickContext, x: number, y: number, z: number): boolean => {
    const above = c.world.getBlock(x, y + 1, z),
      chunk = c.world.getChunk(x >> 5, (y + 1) >> 5, z >> 5);
    if (c.world.blocks.table[above & 0xffff]?.solid) return false;
    return !light || (chunk?.getLight(x & 31, (y + 1) & 31, z & 31) ?? 0) >> 4 >= light;
  };
  return {
    random: (c) => {
      if (smothered !== undefined && c.world.blocks.table[c.world.getBlock(c.x, c.y + 1, c.z) & 0xffff]?.solid)
        return void c.world.setBlock(c.x, c.y, c.z, smothered);
      if (c.random() >= chance) return;
      const x = c.x + Math.floor(c.random() * 3) - 1,
        y = c.y + Math.floor(c.random() * 3) - 1,
        z = c.z + Math.floor(c.random() * 3) - 1;
      if ((c.world.getBlock(x, y, z) & 0xffff) === onto && lit(c, x, y, z)) c.world.setBlock(x, y, z, c.state);
    },
  };
}

/**
 * A block that grows through `stages` (its state data 0 to stages - 1) on random ticks with `chance`, then turns into
 * `grown` (by id) when given (a sapling into a log).
 */
export function growRule(stages: number, chance = 1, grown?: number): VoxelTickRule {
  whole('grow stages', stages, 1, 0xffff);
  if (!(chance >= 0 && chance <= 1)) throw new RangeError(`growRule chance is ${chance}; pass 0..1`);
  return {
    random: (c) => {
      if (c.random() >= chance) return;
      const stage = c.state >>> 16;
      if (stage + 1 < stages) c.world.setBlock(c.x, c.y, c.z, blockState(c.state & 0xffff, stage + 1));
      else if (grown !== undefined) c.world.setBlock(c.x, c.y, c.z, grown);
    },
  };
}

/** Options of {@link fireRule}. */
export interface FireRuleOptions {
  /** Block ids that burn, with their chance per fire tick of catching (0..1). */
  burns: Readonly<Record<number, number>>;
  /** Ticks between fire steps. Default 30. */
  delay?: number;
  /** Fire steps a fire lasts (its state data counts them). Default 8. */
  life?: number;
}

/**
 * Fire: a fire block (put it in a cell to light it) wakes every `delay` ticks, sets fire to the air beside each
 * burnable neighbour with that neighbour's chance (the neighbour burns away into fire), ages, and goes out after
 * `life` steps or when nothing burnable is beside it.
 */
export function fireRule(options: FireRuleOptions): VoxelTickRule {
  if (!options || typeof options !== 'object' || !options.burns || typeof options.burns !== 'object')
    throw new TypeError('fireRule options must be {burns: {[blockId]: chance}}');
  const { delay = 30, life = 8 } = options,
    burns = new Map(Object.entries(options.burns).map(([k, v]) => [Number(k), v]));
  whole('fire delay', delay, 1, 2 ** 20);
  whole('fire life', life, 1, 0xffff);
  for (const chance of burns.values())
    if (!(chance >= 0 && chance <= 1)) throw new RangeError(`fireRule chance is ${chance}; pass 0..1`);
  const step = (c: VoxelTickContext): void => {
    const age = c.state >>> 16,
      id = c.state & 0xffff;
    let fuel = false;
    for (const [dx, dy, dz] of SIDES) {
      const x = c.x + dx,
        y = c.y + dy,
        z = c.z + dz,
        chance = burns.get(c.world.getBlock(x, y, z) & 0xffff);
      if (chance === undefined) continue;
      fuel = true;
      if (c.random() < chance) c.world.setBlock(x, y, z, blockState(id, 0)); // it catches: a new fire there
    }
    if (!fuel || age + 1 >= life) return void c.world.setBlock(c.x, c.y, c.z, 0);
    c.world.setBlock(c.x, c.y, c.z, blockState(id, age + 1));
    c.schedule(delay);
  };
  return {
    // A fire just set (by a player or by spreading) starts its clock.
    placed: (c) => {
      if (c.state >>> 16 === 0) c.schedule(delay);
    },
    scheduled: step,
  };
}
