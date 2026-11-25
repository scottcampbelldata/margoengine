// The physics world (docs/physics-framework.md, sections 2 and 5): one clock, one memory, the field registry, and the solvers
// on them. A render asks for the state at frame N and the world runs every step owed to reach it; nothing reads wall-clock
// time, and nothing is dropped.
//
// Time is counted in base ticks of 7,680 Hz, the rate of level 7, so a solver at level k steps every 2^(7 - k) base ticks and
// two solvers at any levels meet on every step of the slower (Gear and Wells 1984; Neal and Belytschko 1989). The world reads
// film time from a FilmClock (`@margoengine/math/clock`, the one implementation of frame-to-tick arithmetic, shared with
// the rest of a scene), which counts the base ticks of a frame at a rational rate exactly, so no shot length or frame rate
// gains or loses time and the same shot at 24, 30 or 60 frames a second runs the same physics.
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
import { FilmClock, type FrameOffset, type FrameRate } from '@margoengine/math/clock';
import { MargoError } from '@margoengine/math/errors';
import { FieldRegistry, TransferRegistry } from './fields.js';
import { type CouplingGraph, couplingGraph } from './graph.js';
import { Arena, regionWords } from './memory.js';
import { solverNumber } from './random.js';
import { Aitken, Anderson, type Coupling, type CouplingOptions, type CouplingScheme, coupling } from './scheduler.js';
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
  rateOf,
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
export const HYPER_PERIOD = 1 << TOP;

/** Settings of a {@link PhysicsWorld}; every one has a default. */
export interface PhysicsWorldOptions {
  /**
   * The film's clock (`@margoengine/math/clock`), shared with whatever else runs on film time: the world reads its frame and
   * counts base ticks with it (default a new clock at `rate`).
   */
  clock?: FilmClock;
  /** The film's frame rate, when the world makes its own clock (default 24 frames a second). */
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

const WORLD_ID = '';
// Layout versions of the world's own regions.
const CLOCK_LAYOUT = 1;
const SOLVER_LAYOUT = 1;

function checkCell(cell: Cell): void {
  if (!cell || cell.length !== 3 || !cell.every((k) => Number.isInteger(k) && Math.abs(k) < 2147483648))
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

/** A solver alone, or a coupling group, in the order a tick runs them. */
type Unit =
  | { readonly kind: 'one'; readonly entry: Entry }
  | {
      readonly kind: 'group';
      readonly coupling: Coupling;
      /** Members in coupling order (for Strang, [half-stepped, whole-stepped]). */
      readonly members: readonly Entry[];
      /** Fields a member writes and another member reads, by name. */
      readonly shared: readonly string[];
      /** Per shared field, a region the group's readers read during a tick (predicted or iterated values). */
      readonly scratch: Map<string, Region>;
      readonly accelerator: Aitken | Anderson | undefined;
    };

/**
 * A world of solvers on one clock and one memory. Add solvers with {@link PhysicsWorld.add}, then ask for frames with
 * {@link PhysicsWorld.advance}: every step owed runs in coupling order, and nothing is dropped. A cap on the ticks of one
 * call stops between steps; {@link PhysicsWorld.settle} or the next advance runs the rest.
 */
export class PhysicsWorld {
  /** The film clock the world counts its ticks by. */
  readonly clock: FilmClock;
  readonly seed: number;
  readonly gravity: readonly [number, number, number];
  readonly cellSize: number;
  /** The memory every region lies in, and its allocator. */
  readonly arena: Arena;
  /** The fields between the solvers. */
  readonly fields: FieldRegistry;
  /** The framework's transfers between representations. */
  readonly transfers = new TransferRegistry();
  /** The world's tick counts in its memory: [base ticks stepped, base ticks owed]. */
  private readonly counts: Region;
  private entries: Entry[] = [];
  private order: Entry[] = [];
  private graph: CouplingGraph | undefined;
  private checked = false;
  private couplings: Coupling[] = [];
  private units: Unit[] = [];

  constructor(options: PhysicsWorldOptions = {}) {
    const { rate, clock, seed = 1, gravity = [0, -9.80665, 0], cellSize = 4096, memory } = options;
    // Checked by its shape: physics bundles its own copy of @margoengine/math, so the app's FilmClock is another class object.
    if (clock !== undefined && !(typeof clock?.ticks === 'function' && typeof clock.alpha === 'function' && clock.fps))
      throw new TypeError(
        'A world clock is a FilmClock of @margoengine/math/clock; pass one, or a rate for the world to make its own.',
      );
    if (clock && rate && clock.fps.num * rate.den !== rate.num * clock.fps.den)
      throw new RangeError(
        `The clock runs at ${clock.fps.num}/${clock.fps.den} frames a second and the rate given is ${rate.num}/${rate.den}; pass one of them.`,
      );
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295)
      throw new RangeError(`A world seed is a whole number from 0 to 4294967295 (got ${seed}); pass one in range.`);
    if (!gravity || gravity.length !== 3 || !gravity.every(Number.isFinite))
      throw new RangeError('Gravity is three finite numbers in m/s^2; pass [0, -9.80665, 0] for Earth.');
    if (!(cellSize >= 1 && cellSize <= 1048576 && Number.isInteger(cellSize) && (cellSize & (cellSize - 1)) === 0))
      throw new RangeError(`A cell size is a power of two of metres from 1 to 2^20 (got ${cellSize}); pass 4096.`);
    this.clock = clock ?? new FilmClock({ fps: rate ?? 24 });
    this.seed = seed;
    this.gravity = [gravity[0], gravity[1], gravity[2]];
    this.cellSize = cellSize;
    this.arena = new Arena(memory);
    this.fields = new FieldRegistry(this.arena);
    this.counts = this.arena.allocate('clock', 16, 'f64', CLOCK_LAYOUT);
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
   * @throws MargoError `state` for an id with another solver's {@link solverNumber}; RangeError for an id that is empty or
   * taken, a field that clashes with another solver's, a bad cell or rate;
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
      throw new MargoError(
        'state',
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
      if (ran % (1 << (TOP - level)) !== 0)
        throw new MargoError(
          'state',
          `Solver "${id}" steps at level ${level}, and the world is ${ran % (1 << (TOP - level))} base ticks into one of its steps; add it on a multiple of 1/${60 * (1 << level)} s, as at a 1/60 s boundary.`,
        );
      this.words(entry.record).set([level, cell[0], cell[1], cell[2]]);
      this.entries = [...this.entries, entry].sort((a, b) => (a.id < b.id ? -1 : 1));
      this.reorder();
      this.publish(entry, ran / (1 << (TOP - level)) - 1);
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
    this.couplings = this.couplings.filter((c) => !c.ids.includes(id));
    this.fields.remove(id);
    this.reorder();
    return true;
  }

  /**
   * Couples solvers `ids` by `scheme` (docs/physics-framework.md, section 5); solvers not coupled exchange `staggered`. Every
   * scheme but `staggered` needs `ids` to be exactly one coupling group of the graph (solvers that feed each other), checked
   * at the next advance; `iterated` needs every member to have `iterate`. With `bodyMass` and `addedMass` a scheme that
   * exchanges once a tick is refused where the added mass would make it diverge. Couple at a 1/60 s boundary.
   * @throws RangeError for unknown ids, ids already coupled or bad options; MargoError `state` off a 1/60 s boundary or for
   * an unstable once-a-tick exchange.
   */
  couple(ids: readonly string[], scheme: CouplingScheme, options: CouplingOptions = {}): this {
    const c = coupling(ids, scheme, options);
    for (const id of c.ids) {
      this.entry(id);
      if (this.couplings.some((other) => other.ids.includes(id)))
        throw new RangeError(`Solver "${id}" is already coupled; a solver belongs to one coupling.`);
    }
    if (this.tick % HYPER_PERIOD !== 0)
      throw new MargoError(
        'state',
        `The world is ${this.tick % HYPER_PERIOD} base ticks into a 1/60 s step; couple solvers on a 1/60 s boundary, where every level meets.`,
      );
    this.couplings.push(c);
    this.chooseLevels();
    this.checked = false;
    return this;
  }

  /** The scheme solver `id` is coupled by: `staggered` unless {@link PhysicsWorld.couple} said otherwise. */
  schemeOf(id: string): CouplingScheme {
    this.entry(id);
    return this.couplings.find((c) => c.ids.includes(id))?.scheme ?? 'staggered';
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

  /** The film's frame rate, the clock's. */
  get rate(): FrameRate {
    return this.clock.fps;
  }

  /**
   * Runs every step owed up to the clock's time: frame `frame` plus `offset` of the next (a motion-blur sub-frame) when
   * given, which seeks the clock there first, else wherever the clock stands. The steps owed are the clock's whole base
   * ticks, `clock.ticks(7680)`. With `maxTicks` it runs no step that ends more than that many base ticks past the world's
   * time, and {@link PhysicsWorld.settle} or the next advance runs the rest. Returns the base ticks stepped.
   * @throws MargoError `state` for a time before the world's (restore a snapshot to go back), and for a field read or added
   * to that no solver writes; RangeError for a bad frame or offset (the clock's).
   */
  advance(frame?: number, options: { offset?: FrameOffset; maxTicks?: number } = {}): number {
    if (frame !== undefined) this.clock.at(frame, options.offset);
    const target = this.clock.ticks(BASE_HZ),
      counts = this.time64(),
      ran = counts[0]!;
    if (target < ran)
      throw new MargoError(
        'state',
        `Frame ${this.clock.frame} is ${ran - target} base ticks before the world's time; restore a snapshot taken at or before it, then advance.`,
      );
    const cap = options.maxTicks;
    if (cap !== undefined && !(Number.isSafeInteger(cap) && cap >= 1))
      throw new RangeError(
        `maxTicks is a whole number of 1 or more (got ${cap}); leave it out to run every step owed.`,
      );
    counts[1] = Math.max(counts[1]!, target);
    return this.run(cap === undefined ? counts[1]! : Math.min(counts[1]!, ran + cap));
  }

  /** Runs every step a capped advance left, so no time is dropped. Returns the base ticks stepped. */
  settle(): number {
    return this.run(this.time64()[1]!);
  }

  /**
   * How far the clock's time lies past the last step of a solver at `level` that ends at or before it, from 0 to below 1,
   * in steps of that level: what drawing interpolates the last two published values by (`clock.alpha` at the level's
   * rate, exact).
   */
  alpha(level: RateLevel): number {
    if (!isRateLevel(level)) throw new RangeError(`A rate level is a whole number from 0 to 7 (got ${level}).`);
    return this.clock.alpha(rateOf(level));
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
   * same solvers with the same fields as when it was taken. The film clock is the scene's and is left where it stands; the
   * next `advance(frame)` seeks it.
   * @throws MargoError as the snapshot's `restoreSnapshot`, before anything is written.
   */
  restoreSnapshot(bytes: Uint8Array): this {
    restoreRegions(this.memory, this.snapshotSolvers(), bytes);
    return this;
  }

  private snapshotSolvers() {
    const world = {
      describe: () => ({ id: WORLD_ID, fields: [], rate: 0 as RateLevel, stableRate: () => 0 as RateLevel }),
      stateRegions: () => [this.counts, ...this.entries.map((e) => e.record), ...this.fields.stateRegions()],
      extraState: () => [],
    };
    return [world, ...this.entries.map((e) => e.solver)];
  }

  private run(until: number): number {
    const clock = this.time64(),
      start = clock[0]!;
    let ran = start;
    for (;;) {
      if (ran % HYPER_PERIOD === 0) this.chooseLevels();
      const fine = this.fineStride(),
        t = ran + fine - (ran % fine);
      if (t > until) break;
      if (!this.checked) this.check();
      for (const unit of this.units) this.visit(unit, t);
      ran = t;
      this.time64()[0] = ran;
    }
    return ran - start;
  }

  /** One step of one solver: sums into what it owns, imports, steps and publishes. */
  private stepOne(e: Entry, tick: number, dt: number): void {
    this.begin(e, tick);
    e.solver.step(this.context(e, tick), dt);
    this.publish(e, tick);
  }

  /** Sums what others added to the fields `e` owns, and lets it import them. */
  private begin(e: Entry, tick: number): void {
    e.sums.clear();
    for (const name of e.summed) {
      const sum = this.fields.sum(name, tick, this.cellOf(e.id));
      if (sum) e.sums.set(name, sum);
    }
    e.solver.importPorts(tick);
  }

  /** The step context of `e`: its readers' ports as published, or from `scratch` for the fields a group shares. */
  private context(e: Entry, tick: number, scratch?: ReadonlyMap<string, Region>) {
    const inputs = new Map<string, Port>();
    for (const name of e.reads) {
      const own = scratch?.get(name),
        port = own ? { field: name, region: own, tick, cell: this.fields.port(name)!.cell } : this.fields.port(name);
      if (port) inputs.set(name, port);
    }
    return { tick, level: this.levelOf(e.id), seed: this.seed, inputs, cell: this.cellOf(e.id) };
  }

  private stride(e: Entry): number {
    return 1 << (TOP - this.levelOf(e.id));
  }

  /** Runs `unit`'s steps that end at base tick `t`. */
  private visit(unit: Unit, t: number): void {
    if (unit.kind === 'one') {
      const s = this.stride(unit.entry);
      if (t % s === 0) this.stepOne(unit.entry, t / s - 1, s / BASE_HZ);
      return;
    }
    const { coupling: c, members } = unit;
    if (c.scheme === 'staggered' || c.scheme === 'strang') {
      // Strang: the whole-stepped member first on shared ticks, so it falls between the half steps of the other.
      for (const e of c.scheme === 'strang' ? [members[1]!, members[0]!] : members) {
        const s = this.stride(e);
        if (t % s === 0) this.stepOne(e, t / s - 1, s / BASE_HZ);
      }
      return;
    }
    // The other schemes step their members at one level, together.
    const s = this.stride(members[0]!);
    if (t % s !== 0) return;
    const tick = t / s - 1,
      dt = s / BASE_HZ;
    if (c.scheme === 'predicted') {
      for (const name of unit.shared) this.predict(name, unit.scratch.get(name)!, t);
      for (const e of members) {
        this.begin(e, tick);
        e.solver.step(this.context(e, tick, unit.scratch), dt);
      }
      for (const e of members) this.publish(e, tick);
    } else if (c.scheme === 'implicitPressure') {
      const solvers = members.filter((e) => this.addsToGroup(e, members)),
        bodies = members.filter((e) => !solvers.includes(e));
      for (const e of bodies) this.stepOne(e, tick, dt);
      for (const e of solvers) this.stepOne(e, tick, dt);
      // The bodies take the impulses of this tick's solve now.
      for (const e of bodies) this.begin(e, tick);
    } else this.iterate(unit, tick, dt);
  }

  /** Whether `e` adds to a field another member of `members` owns. */
  private addsToGroup(e: Entry, members: readonly Entry[]): boolean {
    return e.description.fields.some(
      (u) =>
        u.access === 'accumulate' && members.some((m) => m !== e && this.fields.field(u.field.name)?.owner === m.id),
    );
  }

  /** Writes field `name` extrapolated linearly from its last two values to base tick `t` into `into`. */
  private predict(name: string, into: Region, t: number): void {
    const f = this.fields.field(name)!,
      out = regionWords(this.memory, into),
      current = regionWords(this.memory, f.current!.port.region),
      end = (p: { port: Port; level: RateLevel }) => (p.port.tick + 1) * (1 << (TOP - p.level)),
      tc = end(f.current!),
      tp = f.previous ? end(f.previous) : tc;
    if (tp === tc) {
      out.set(current);
      return;
    }
    const previous = regionWords(this.memory, f.previous!.port.region),
      k = (t - tc) / (tc - tp);
    for (let i = 0; i < out.length; i++) out[i] = current[i]! + (current[i]! - previous[i]!) * k;
  }

  /**
   * Runs a strongly coupled group's tick a fixed number of times: each run every member steps on the shared values (Jacobi),
   * then all publish; between runs the registry goes back to the tick's start and the shared values move by the accelerator.
   */
  private iterate(unit: Unit & { kind: 'group' }, tick: number, dt: number): void {
    const { coupling: c, members, shared, scratch } = unit,
      accelerator = unit.accelerator!,
      regions = [...new Set(members.flatMap((e) => e.description.fields.map((u) => u.field.name)))]
        .sort()
        .flatMap((name) => this.fields.regionsOf(name)),
      saved = regions.map((r) => new Uint8Array(this.memory.buffer, r.byteOffset, r.byteLength).slice());
    const gather = (out: Float64Array) => {
      let at = 0;
      for (const name of shared) {
        const words = regionWords(this.memory, this.fields.field(name)!.current!.port.region);
        for (let i = 0; i < words.length; i++) out[at++] = words[i]!;
      }
    };
    const n = this.sharedLength(shared),
      x = new Float64Array(n),
      g = new Float64Array(n);
    gather(x);
    accelerator.reset();
    for (let run = 0; run < c.iterations; run++) {
      if (run > 0)
        regions.forEach((r, i) => new Uint8Array(this.memory.buffer, r.byteOffset, r.byteLength).set(saved[i]!));
      let at = 0;
      for (const name of shared) {
        const words = regionWords(this.memory, scratch.get(name)!);
        for (let i = 0; i < words.length; i++) words[i] = x[at++]!;
      }
      for (const e of members) {
        this.begin(e, tick);
        const context = this.context(e, tick, scratch);
        if (run === 0) e.solver.step(context, dt);
        else e.solver.iterate!(context, dt);
      }
      for (const e of members) this.publish(e, tick);
      if (run < c.iterations - 1) {
        gather(g);
        accelerator.next(x, g, x);
      }
    }
  }

  private sharedLength(shared: readonly string[]): number {
    let n = 0;
    for (const name of shared) n += regionWords(this.memory, this.fields.field(name)!.current!.port.region).length;
    return n;
  }

  private publish(e: Entry, tick: number): void {
    const level = this.levelOf(e.id),
      cell = this.cellOf(e.id);
    for (const port of e.solver.exportPorts(tick)) this.fields.publish(e.id, { ...port, cell }, level);
  }

  /**
   * Each solver's level from its state: the faster of its rate and its stability limit; the members of a coupling that steps
   * together at the fastest of theirs, and a Strang pair's half-stepped member one level above the other.
   * @throws MargoError `state` for a Strang pair whose whole-stepped member needs level 7.
   */
  private chooseLevels(): void {
    const level = new Map(this.entries.map((e) => [e.id, this.chooseLevel(e)]));
    for (const c of this.couplings) {
      if (c.scheme === 'staggered') continue;
      if (c.scheme === 'strang') {
        const [a, b] = c.ids as [string, string];
        if (level.get(b)! >= 7)
          throw new MargoError(
            'state',
            `Strang pair "${a}" and "${b}": "${b}" needs level 7, so "${a}" cannot step at half its step; couple them another way.`,
          );
        const half = Math.max(level.get(a)!, level.get(b)! + 1);
        level.set(a, half as RateLevel);
        level.set(b, (half - 1) as RateLevel);
        continue;
      }
      const top = Math.max(...c.ids.map((id) => level.get(id)!)) as RateLevel;
      for (const id of c.ids) level.set(id, top);
    }
    for (const e of this.entries) this.words(e.record)[0] = level.get(e.id)!;
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
    return 1 << (TOP - level);
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

  /**
   * Before the first step after a change: every field read or added to has a writer, every coupling is one coupling group,
   * and the order of units a tick runs is built.
   */
  private check(): void {
    for (const f of this.fields.list())
      if (f.owner === undefined)
        throw new MargoError(
          'state',
          `No solver writes field "${f.descriptor.name}", which ${[...f.readers, ...f.contributors].join(', ')} use; add the solver that owns it.`,
        );
    const graph = couplingGraph(this.nodes()),
      units: Unit[] = [],
      placed = new Set<Coupling>();
    for (const e of this.order) {
      const c = this.couplings.find((x) => x.ids.includes(e.id));
      if (!c) {
        units.push({ kind: 'one', entry: e });
        continue;
      }
      if (placed.has(c)) continue;
      placed.add(c);
      units.push(this.groupUnit(c, graph));
    }
    this.units = units;
    this.checked = true;
  }

  private groupUnit(c: Coupling, graph: CouplingGraph): Unit {
    const members = c.ids.map((id) => this.entry(id));
    if (c.scheme !== 'staggered') {
      const group = graph.groupOf.get(c.ids[0]!)!,
        ids = [...graph.groups[group]!];
      if (ids.length !== c.ids.length || !c.ids.every((id) => ids.includes(id)))
        throw new MargoError(
          'state',
          `The '${c.scheme}' coupling of ${c.ids.join(', ')} is not one coupling group (solvers that feed each other: ${ids.join(', ')}); couple exactly a group.`,
        );
    }
    if (c.scheme === 'staggered') members.sort((a, b) => this.order.indexOf(a) - this.order.indexOf(b));
    const shared = [
      ...new Set(
        members.flatMap((e) =>
          e.reads.filter((name) => members.some((m) => m !== e && this.fields.field(name)?.owner === m.id)),
        ),
      ),
    ].sort();
    if (c.scheme === 'iterated') {
      for (const e of members)
        if (typeof e.solver.iterate !== 'function')
          throw new MargoError(
            'state',
            `Solver "${e.id}" is coupled 'iterated' and has no iterate(); give it one or couple it another way.`,
          );
      if (shared.length === 0)
        throw new MargoError(
          'state',
          `The 'iterated' coupling of ${c.ids.join(', ')} shares no field a member writes and another reads; nothing to iterate on.`,
        );
    }
    if (c.scheme === 'implicitPressure' && !members.some((e) => this.addsToGroup(e, members)))
      throw new MargoError(
        'state',
        `The 'implicitPressure' coupling of ${c.ids.join(', ')} has no member that adds to another's fields (the solve that takes the bodies in).`,
      );
    const scratch = new Map<string, Region>();
    if (c.scheme === 'predicted' || c.scheme === 'iterated')
      for (const name of shared) {
        const mirror = this.fields.field(name)!.current!.port.region;
        if (c.scheme === 'predicted' && mirror.type !== 'f32' && mirror.type !== 'f64')
          throw new MargoError(
            'state',
            `Field "${name}" holds ${mirror.type} words, which cannot be extrapolated; couple it another way.`,
          );
        scratch.set(name, this.arena.allocate(`${c.scheme}:${name}`, mirror.byteLength, mirror.type, mirror.layout));
      }
    const n = c.scheme === 'iterated' ? this.sharedLength(shared) : 0,
      accelerator =
        c.scheme !== 'iterated'
          ? undefined
          : c.accelerator === 'aitken'
            ? new Aitken(n, c.relaxation)
            : new Anderson(n, c.depth);
    return { kind: 'group', coupling: c, members, shared, scratch, accelerator };
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
    return regionWords(this.memory, this.counts) as Float64Array;
  }
}
