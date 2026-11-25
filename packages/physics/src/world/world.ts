// The physics world (docs/physics-framework.md, sections 2 and 5): one clock, one memory, the field registry, and the solvers
// on them. A render asks for the state at frame N and the world runs every step owed to reach it; nothing reads wall-clock
// time, and nothing is dropped.
//
// Time is counted in base ticks of 7,680 Hz, the rate of level 7, so a solver at level k steps every 2^(7 - k) base ticks and
// two solvers at any levels meet on every step of the slower (Gear and Wells 1984; Neal and Belytschko 1989). A frame of a film
// at a rational rate maps to base ticks in exact integer arithmetic, so no shot length or frame rate gains or loses time and
// the same shot at 24, 30 or 60 frames a second runs the same physics.
//
// The world's own state lies in regions of the same memory as the solvers': the clock, each solver's rate level and origin
// cell, and the field registry. The state hash and a snapshot take them with the solvers' state, under the id '' (no solver
// may take it), so a restore puts back the levels a solver's stability limit chose and the values its readers saw.
//
// A solver runs at the faster of its preferred rate and its stability limit, chosen from its state at every 1/60 s boundary,
// where every level's steps meet. Within a visit of a base tick the solvers that step on it run in coupling order (groups as
// the coupling graph orders them, ids within a group): each sums what was added to the fields it owns, imports, steps and
// publishes. That is the staggered scheme (Felippa, Park and Farhat 2001); the scheduler's other schemes build on it.
//
// Large worlds (floating origin, Thorne 2005): each solver steps in the frame of its origin cell, a cube of `cellSize` metres
// (a power of two) indexed by three whole numbers. Moving an origin changes whole numbers only, never a float offset, so it
// changes no bit of simulated state; a position goes from one cell's frame to another's through the integer cell difference.
import { MargoError } from '@margoengine/math/errors';
import { FieldRegistry, TransferRegistry } from './fields.js';
import { type CouplingGraph, couplingGraph } from './graph.js';
import { Arena, regionWords } from './memory.js';
import { solverNumber } from './random.js';
import {
  restoreSnapshot as restoreRegions,
  type Snapshot,
  stateHash,
  takeSnapshot as takeRegions,
} from './snapshot.js';
import {
  type Cell,
  isRateLevel,
  type Port,
  type RateLevel,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
} from './solver.js';

/** Base ticks a second: the rate of level 7, 60 * 2^7 Hz. */
export const BASE_HZ = 7680;
/** The finest rate level. */
const TOP = 7;
/** Base ticks in a step of level 0 (1/60 s): every level's steps meet on a multiple of it. */
export const HYPER_PERIOD = 2 ** TOP;

/** A film's frame rate as a ratio of whole numbers: `num / den` frames a second (`{num: 24000, den: 1001}` for 23.976). */
export interface FrameRate {
  readonly num: number;
  readonly den: number;
}

/** Settings of a {@link PhysicsWorld}; every one has a default. */
export interface PhysicsWorldOptions {
  /** The film's frame rate (default 24 frames a second). */
  rate?: FrameRate;
  /** The seed solvers key their random numbers by, an unsigned 32-bit word (default 1). */
  seed?: number;
  /** Gravity in m/s^2 (default standard gravity down y, [0, -9.80665, 0], ISO 80000-3). */
  gravity?: readonly [number, number, number];
  /** Metres an origin cell spans, a power of two from 1 to 2^20 (default 4,096: f32 offsets inside keep 0.25 mm). */
  cellSize?: number;
  /** The memory to put every region in (default a new one, growing as solvers allocate). */
  memory?: WebAssembly.Memory;
}

const DEFAULT_RATE: FrameRate = { num: 24, den: 1 };
const WORLD_ID = '';
// Layout versions of the world's own regions.
const CLOCK_LAYOUT = 1;
const SOLVER_LAYOUT = 1;

/**
 * The base ticks owed at frame `frame` of a film at `rate`, plus `part` (a ratio `p / q` of a frame, for motion-blur
 * sub-frames): floor((frame + part) * 7680 * den / num), in whole numbers, so it is a pure function of the frame and the rate.
 * @throws RangeError for a frame, part or rate that is not whole and in range, or a time past 2^53 ticks.
 */
export function ticksAt(frame: number, rate: FrameRate, part: readonly [number, number] = [0, 1]): number {
  const [numerator, denominator] = framePoint(frame, rate, part);
  return divide(numerator, denominator);
}

/** Frame `frame` plus `part` as the exact ratio of base ticks numerator / denominator. */
function framePoint(frame: number, rate: FrameRate, part: readonly [number, number]): [number, number] {
  checkRate(rate);
  const [p, q] = part;
  if (!Number.isSafeInteger(frame) || frame < 0)
    throw new RangeError(`A frame is a whole number of 0 or more (got ${frame}); pass the frame index.`);
  if (!Number.isSafeInteger(p) || !Number.isSafeInteger(q) || q < 1 || p < 0 || p >= q)
    throw new RangeError(`A sub-frame is a ratio p/q with 0 <= p < q (got ${p}/${q}); pass whole numbers.`);
  const numerator = (frame * q + p) * rate.den * BASE_HZ,
    denominator = q * rate.num;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator * HYPER_PERIOD))
    throw new RangeError(
      `Frame ${frame} at ${rate.num}/${rate.den} is past the ticks a world counts exactly (2^53); split the shot.`,
    );
  return [numerator, denominator];
}

/** floor(a / b) for whole numbers below 2^53, exactly: the float quotient corrected by one either way if it rounded across. */
function divide(a: number, b: number): number {
  let q = Math.floor(a / b);
  if (q * b > a) q--;
  else if ((q + 1) * b <= a) q++;
  return q;
}

function checkRate(rate: FrameRate): void {
  if (!rate || !Number.isSafeInteger(rate.num) || !Number.isSafeInteger(rate.den) || rate.num < 1 || rate.den < 1)
    throw new RangeError(
      'A frame rate is a ratio of whole numbers above 0, {num, den}; pass {num: 24, den: 1} or {num: 24000, den: 1001}.',
    );
}

function checkCell(cell: Cell): void {
  if (!cell || cell.length !== 3 || !cell.every((k) => Number.isInteger(k) && Math.abs(k) < 2 ** 31))
    throw new RangeError('A cell is three whole numbers within +-2^31; pass [i, j, k].');
}

/** One solver in the world, and what the world keeps of it outside its regions. */
interface Entry {
  readonly solver: Solver<unknown>;
  readonly description: SolverDescription;
  readonly id: string;
  /** The world's record of it: [rate level, cell x, cell y, cell z], i32. */
  readonly record: Region;
  /** The sums of the fields it owns that others add to, from its last step. */
  readonly sums: Map<string, Port>;
  /** Fields it owns that others accumulate into, and fields it reads. */
  readonly summed: readonly string[];
  readonly reads: readonly string[];
}

/**
 * A world of solvers on one clock and one memory. Add solvers with {@link PhysicsWorld.add}, then ask for frames with
 * {@link PhysicsWorld.advance}: every step owed runs in coupling order, and nothing is dropped. A cap on the ticks of one
 * call stops between steps; {@link PhysicsWorld.settle} or the next advance runs the rest.
 */
export class PhysicsWorld {
  readonly rate: FrameRate;
  readonly seed: number;
  readonly gravity: readonly [number, number, number];
  readonly cellSize: number;
  /** The memory every region lies in, and its allocator. */
  readonly arena: Arena;
  /** The fields between the solvers. */
  readonly fields: FieldRegistry;
  /** The framework's transfers between representations. */
  readonly transfers = new TransferRegistry();
  private readonly clock: Region;
  private entries: Entry[] = [];
  private order: Entry[] = [];
  private graph: CouplingGraph | undefined;
  private checked = false;

  constructor(options: PhysicsWorldOptions = {}) {
    const { rate = DEFAULT_RATE, seed = 1, gravity = [0, -9.80665, 0], cellSize = 4096, memory } = options;
    checkRate(rate);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295)
      throw new RangeError(`A world seed is a whole number from 0 to 4294967295 (got ${seed}); pass one in range.`);
    if (!gravity || gravity.length !== 3 || !gravity.every(Number.isFinite))
      throw new RangeError('Gravity is three finite numbers in m/s^2; pass [0, -9.80665, 0] for Earth.');
    if (!(cellSize >= 1 && cellSize <= 2 ** 20 && Number.isInteger(Math.log2(cellSize))))
      throw new RangeError(`A cell size is a power of two of metres from 1 to 2^20 (got ${cellSize}); pass 4096.`);
    this.rate = { num: rate.num, den: rate.den };
    this.seed = seed;
    this.gravity = [gravity[0], gravity[1], gravity[2]];
    this.cellSize = cellSize;
    this.arena = new Arena(memory);
    this.fields = new FieldRegistry(this.arena);
    // [base ticks stepped, base ticks owed]
    this.clock = this.arena.allocate('clock', 16, 'f64', CLOCK_LAYOUT);
  }

  /** The world's memory. */
  get memory(): WebAssembly.Memory {
    return this.arena.memory;
  }

  /** Base ticks the world has stepped to: every solver's state is at this time or at its last step before it. */
  get tick(): number {
    return this.time64()[0]!;
  }

  /** The world's time in seconds: {@link PhysicsWorld.tick} over 7,680. */
  get time(): number {
    return this.tick / BASE_HZ;
  }

  /** True when no step owed by the last advance is left to run (false only after a capped advance). */
  get settled(): boolean {
    const [ran, owed] = this.time64();
    return ran! + this.fineStride() > owed!;
  }

  /** The solvers' ids, in id order. */
  get ids(): string[] {
    return this.entries.map((e) => e.id);
  }

  /** The coupling graph of the solvers, rebuilt as solvers come and go. */
  get coupling(): CouplingGraph {
    this.graph ??= couplingGraph(this.nodes(), true);
    return this.graph;
  }

  /**
   * Adds `solver`, made from `params`, stepping in origin cell `cell`: declares its fields, calls `init` with a host over the
   * world's memory, chooses its rate level and publishes its ports as of now. A solver is added where a step of its level
   * would begin, so its first step covers a whole step.
   * @throws RangeError for an id that is empty or taken or has another solver's {@link solverNumber}, a field that clashes with another solver's, a bad cell or rate;
   * MargoError `state` when the world's time is not on a step of the solver's level.
   */
  add<Params>(solver: Solver<Params>, params: Params, cell: Cell = [0, 0, 0]): this {
    const description = solver.describe(),
      { id } = description;
    if (typeof id !== 'string' || id === WORLD_ID)
      throw new RangeError('A solver id is a non-empty string; the empty id is the world itself.');
    if (this.entries.some((e) => e.id === id))
      throw new RangeError(`A solver with the id "${id}" is already in the world; give each its own id.`);
    const number = solverNumber(id),
      twin = this.entries.find((e) => solverNumber(e.id) === number);
    if (twin)
      throw new RangeError(
        `Solvers "${twin.id}" and "${id}" have the same random-stream number (${number}), so they would draw the same numbers; rename one.`,
      );
    if (!isRateLevel(description.rate))
      throw new RangeError(
        `Solver "${id}" prefers rate level ${description.rate}; a level is a whole number from 0 to 7.`,
      );
    checkCell(cell);
    this.fields.declare(id, description.fields);
    const entry: Entry = {
      solver: solver as Solver<unknown>,
      description,
      id,
      record: this.arena.allocate(`solver:${id}`, 16, 'i32', SOLVER_LAYOUT),
      sums: new Map(),
      summed: [],
      reads: description.fields.filter((u) => u.access === 'read').map((u) => u.field.name),
    };
    try {
      solver.init(this.host(entry), params);
      const level = this.chooseLevel(entry),
        ran = this.tick;
      if (ran % 2 ** (TOP - level) !== 0)
        throw new MargoError(
          'state',
          `Solver "${id}" steps at level ${level}, and the world is ${ran % 2 ** (TOP - level)} base ticks into one of its steps; add it on a multiple of 1/${60 * 2 ** level} s, as at a 1/60 s boundary.`,
        );
      this.words(entry.record).set([level, cell[0], cell[1], cell[2]]);
      this.entries = [...this.entries, entry].sort((a, b) => (a.id < b.id ? -1 : 1));
      this.reorder();
      this.publish(entry, ran / 2 ** (TOP - level) - 1);
    } catch (error) {
      this.entries = this.entries.filter((e) => e !== entry);
      this.fields.remove(id);
      this.reorder();
      throw error;
    }
    return this;
  }

  /** Takes solver `id` out; false when there is none. Its regions stay allocated (the memory only grows). */
  remove(id: string): boolean {
    if (!this.entries.some((e) => e.id === id)) return false;
    this.entries = this.entries.filter((e) => e.id !== id);
    this.fields.remove(id);
    this.reorder();
    return true;
  }

  /** The rate level solver `id` steps at now. @throws RangeError for an unknown solver. */
  levelOf(id: string): RateLevel {
    return this.words(this.entry(id).record)[0] as RateLevel;
  }

  /** The origin cell solver `id` steps in. @throws RangeError for an unknown solver. */
  cellOf(id: string): Cell {
    const w = this.words(this.entry(id).record);
    return [w[1]!, w[2]!, w[3]!];
  }

  /** Moves solver `id`'s frame to another cell: only the whole numbers of its cell change, no bit of its state. */
  setCell(id: string, cell: Cell): this {
    checkCell(cell);
    this.words(this.entry(id).record).set(cell, 1);
    return this;
  }

  /**
   * Moves the origin by `delta` cells (as it follows a camera or a ship): every solver's cell shifts by the whole numbers, so
   * no simulated state changes. All or nothing.
   * @throws RangeError when a cell would leave +-2^31.
   */
  shiftOrigin(delta: Cell): this {
    checkCell(delta);
    const moved = this.entries.map((e) => {
      const c = this.cellOf(e.id),
        m: Cell = [c[0] - delta[0], c[1] - delta[1], c[2] - delta[2]];
      checkCell(m);
      return m;
    });
    this.entries.forEach((e, i) => this.words(e.record).set(moved[i]!, 1));
    return this;
  }

  /**
   * A position given in the frame of cell `from`, in the frame of cell `to`: offset + (from - to) * cellSize, the cell
   * difference a whole number of metres. Writes into `out`.
   */
  relocate(
    offset: readonly [number, number, number],
    from: Cell,
    to: Cell,
    out: [number, number, number] = [0, 0, 0],
  ): [number, number, number] {
    for (let k = 0; k < 3; k++) out[k] = offset[k]! + (from[k]! - to[k]!) * this.cellSize;
    return out;
  }

  /**
   * Runs every step owed up to frame `frame` (plus `part` of the next, for a motion-blur sub-frame). With `maxTicks` it runs
   * no step that ends more than that many base ticks past the world's time, and {@link PhysicsWorld.settle} or the next
   * advance runs the rest. Returns the base ticks stepped.
   * @throws MargoError `state` for a frame before the world's time (restore a snapshot to go back), and for a field read
   * or added to that no solver writes.
   */
  advance(frame: number, options: { part?: readonly [number, number]; maxTicks?: number } = {}): number {
    const target = ticksAt(frame, this.rate, options.part),
      clock = this.time64(),
      ran = clock[0]!;
    if (target < ran)
      throw new MargoError(
        'state',
        `Frame ${frame} is ${ran - target} base ticks before the world's time; restore a snapshot taken at or before it, then advance.`,
      );
    const cap = options.maxTicks;
    if (cap !== undefined && !(Number.isSafeInteger(cap) && cap >= 1))
      throw new RangeError(
        `maxTicks is a whole number of 1 or more (got ${cap}); leave it out to run every step owed.`,
      );
    clock[1] = Math.max(clock[1]!, target);
    return this.run(cap === undefined ? clock[1]! : Math.min(clock[1]!, ran + cap));
  }

  /** Runs every step a capped advance left, so no time is dropped. Returns the base ticks stepped. */
  settle(): number {
    return this.run(this.time64()[1]!);
  }

  /**
   * How far frame `frame` (plus `part`) lies past the last step of a solver at `level` that ends at or before it, from 0 to
   * below 1, in steps of that level: what drawing interpolates the last two published values by. Exact rational arithmetic
   * and one division.
   */
  alpha(frame: number, level: RateLevel, part: readonly [number, number] = [0, 1]): number {
    if (!isRateLevel(level)) throw new RangeError(`A rate level is a whole number from 0 to 7 (got ${level}).`);
    const [numerator, denominator] = framePoint(frame, this.rate, part),
      stride = 2 ** (TOP - level),
      before = divide(numerator, denominator * stride) * stride;
    return (numerator - before * denominator) / (stride * denominator);
  }

  /** The state hash of the world: its clock, levels, cells and fields, and every solver's state (16 hex digits). */
  hash(): string {
    return stateHash(this.memory, this.snapshotSolvers());
  }

  /** A snapshot of the world's and every solver's state, which {@link PhysicsWorld.restoreSnapshot} puts back bit for bit. */
  takeSnapshot(): Snapshot {
    return takeRegions(this.memory, this.snapshotSolvers());
  }

  /**
   * Puts the world back as `bytes` (a snapshot's) found it; the run goes on bit for bit as it did. The world must hold the
   * same solvers with the same fields as when it was taken.
   * @throws MargoError as the snapshot's `restoreSnapshot`, before anything is written.
   */
  restoreSnapshot(bytes: Uint8Array): this {
    restoreRegions(this.memory, this.snapshotSolvers(), bytes);
    return this;
  }

  private snapshotSolvers() {
    const world = {
      describe: () => ({ id: WORLD_ID, fields: [], rate: 0 as RateLevel, stableRate: () => 0 as RateLevel }),
      stateRegions: () => [this.clock, ...this.entries.map((e) => e.record), ...this.fields.stateRegions()],
      extraState: () => [],
    };
    return [world, ...this.entries.map((e) => e.solver)];
  }

  private run(until: number): number {
    const clock = this.time64(),
      start = clock[0]!;
    let ran = start;
    for (;;) {
      if (ran % HYPER_PERIOD === 0) for (const e of this.entries) this.words(e.record)[0] = this.chooseLevel(e);
      const fine = this.fineStride(),
        t = ran + fine - (ran % fine);
      if (t > until) break;
      if (!this.checked) this.check();
      for (const e of this.order) {
        const stride = 2 ** (TOP - this.levelOf(e.id));
        if (t % stride === 0) this.stepOne(e, t / stride - 1, stride / BASE_HZ);
      }
      ran = t;
      this.time64()[0] = ran;
    }
    return ran - start;
  }

  /** One step of one solver: sums into what it owns, imports, steps and publishes. */
  private stepOne(e: Entry, tick: number, dt: number): void {
    e.sums.clear();
    for (const name of e.summed) {
      const sum = this.fields.sum(name, tick, this.cellOf(e.id));
      if (sum) e.sums.set(name, sum);
    }
    e.solver.importPorts(tick);
    const inputs = new Map<string, Port>();
    for (const name of e.reads) {
      const port = this.fields.port(name);
      if (port) inputs.set(name, port);
    }
    e.solver.step({ tick, level: this.levelOf(e.id), seed: this.seed, inputs, cell: this.cellOf(e.id) }, dt);
    this.publish(e, tick);
  }

  private publish(e: Entry, tick: number): void {
    const level = this.levelOf(e.id),
      cell = this.cellOf(e.id);
    for (const port of e.solver.exportPorts(tick)) this.fields.publish(e.id, { ...port, cell }, level);
  }

  /** The faster of a solver's preferred rate and its stability limit, from its state now. */
  private chooseLevel(e: Entry): RateLevel {
    const limit = e.description.stableRate();
    if (!isRateLevel(limit))
      throw new RangeError(`Solver "${e.id}" gave stability limit ${limit}; stableRate() returns a level from 0 to 7.`);
    return Math.max(e.description.rate, limit) as RateLevel;
  }

  /** Base ticks between visits: the stride of the fastest solver, or a step of level 0 with none. */
  private fineStride(): number {
    let level = 0;
    for (const e of this.entries) level = Math.max(level, this.levelOf(e.id));
    return 2 ** (TOP - level);
  }

  private host(e: Entry): SolverHost {
    const arena = this.arena,
      id = e.id;
    return {
      memory: arena.memory,
      gravity: this.gravity,
      allocate: (name, byteLength, type, layout) => arena.allocate(name, byteLength, type, layout),
      port: (field) => {
        const registered = this.fields.field(field);
        if (registered?.owner === id) return e.sums.get(field);
        return registered?.current?.port;
      },
    };
  }

  private reorder(): void {
    this.graph = couplingGraph(this.nodes(), true);
    const byId = new Map(this.entries.map((e) => [e.id, e]));
    this.order = this.graph.groups.flatMap((group) => group.map((id) => byId.get(id)!));
    for (const e of this.entries)
      (e as { summed: readonly string[] }).summed = e.description.fields
        .filter((u) => u.access === 'write' && (this.fields.field(u.field.name)?.contributors.length ?? 0) > 0)
        .map((u) => u.field.name);
    this.checked = false;
  }

  /** Every field read or added to has a writer, before the first step. */
  private check(): void {
    for (const f of this.fields.list())
      if (f.owner === undefined)
        throw new MargoError(
          'state',
          `No solver writes field "${f.descriptor.name}", which ${[...f.readers, ...f.contributors].join(', ')} use; add the solver that owns it.`,
        );
    this.checked = true;
  }

  private nodes() {
    return this.entries.map((e) => {
      const of = (access: string) => e.description.fields.filter((u) => u.access === access).map((u) => u.field.name);
      return { id: e.id, writes: of('write'), reads: of('read'), accumulates: of('accumulate') };
    });
  }

  private entry(id: string): Entry {
    const e = this.entries.find((x) => x.id === id);
    if (!e) throw new RangeError(`No solver "${id}" in the world; add it first.`);
    return e;
  }

  private words(region: Region): Int32Array {
    return regionWords(this.memory, region) as Int32Array;
  }

  private time64(): Float64Array {
    return regionWords(this.memory, this.clock) as Float64Array;
  }
}
