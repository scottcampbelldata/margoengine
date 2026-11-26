// The solver contract of the physics framework (docs/physics-framework.md, section 5): the one shape every solver of a
// `PhysicsWorld` has, whatever it simulates. A solver never calls another; everything between solvers crosses declared
// ports on shared fields (section 4), and the world builds the coupling graph from what each solver declares it reads,
// writes and accumulates. Its state lives in regions the world assigns it, so the world alone snapshots, restores and
// hashes every solver the same way (section 8), and a step is a pure function of that state, its input ports, the tick
// length and its random-number counter (section 7).
//
// The rates are dyadic and fixed in seconds: a solver steps at 60 * 2^level Hz, level 0 to 7, so two coupled solvers
// always meet on a shared tick and the faster one runs a whole power of two of steps per coupling interval (Neal and
// Belytschko, "Explicit-explicit subcycling with non-integer time step ratios for structural dynamic systems",
// Computers and Structures 31(6), 1989; Gear and Wells, "Multirate linear multistep methods", BIT 24, 1984).

/** The slowest solver rate, in steps a second: rate level 0. */
export const BASE_RATE = 60;
/** How many rate levels there are: 0 (60 Hz) to 7 (7,680 Hz). */
export const RATE_LEVELS = 8;

/** A dyadic rate level: the solver steps at `BASE_RATE * 2 ** level` steps a second. */
export type RateLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Whether `value` is a rate level, an integer from 0 to 7. */
export function isRateLevel(value: unknown): value is RateLevel {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < RATE_LEVELS;
}

/**
 * The steps a second of a rate level: 60, 120, 240, ... 7,680.
 * @throws RangeError for a value that is not a rate level.
 */
export function rateOf(level: RateLevel): number {
  if (!isRateLevel(level))
    throw new RangeError(`A rate level is an integer from 0 to ${RATE_LEVELS - 1}; got ${level}.`);
  return BASE_RATE * (1 << level);
}

/**
 * How many steps a solver at `fast` takes for each step of one at `slow`: `2 ** (fast - slow)`, a whole number, so the
 * two meet on every tick of the slower.
 * @throws RangeError when `fast` is slower than `slow`, or either is not a rate level.
 */
export function substepsBetween(fast: RateLevel, slow: RateLevel): number {
  if (!isRateLevel(fast) || !isRateLevel(slow)) throw new RangeError('Both rates must be rate levels from 0 to 7.');
  if (fast < slow) throw new RangeError(`Rate level ${fast} is slower than ${slow}; pass the faster level first.`);
  return 1 << (fast - slow);
}

/** How a field is laid out (docs/physics-framework.md, section 4). */
export type FieldKind =
  | 'uniformGrid'
  | 'sparseGrid'
  | 'heightfield'
  | 'particleSet'
  | 'meshVertexSet'
  | 'surfaceSampleSet'
  | 'bodySet'
  | 'scalarSeries';

/** Where a field's values sit on its layout. */
export type Centring = 'cell' | 'face' | 'vertex' | 'particle';

/** The element type of a region's words. */
export type ElementType = 'f32' | 'f64' | 'i32' | 'u32' | 'u8';

/** How a solver uses a field: it owns it (`write`, one writer per field), reads it, or adds to it (`accumulate`). */
export type FieldAccess = 'read' | 'write' | 'accumulate';

/** A field that crosses a solver boundary: what it holds, in SI units, and on what layout. */
export interface FieldDescriptor {
  /** The field's name in the registry, unique in a world (for example `'gravity'`, `'bodies'`, `'seaSurface'`). */
  readonly name: string;
  readonly kind: FieldKind;
  /** The physical quantity (`'velocity'`, `'pressure'`, `'impulse'`, `'height'`, ...). */
  readonly quantity: string;
  /** Its SI unit, as text (`'m/s'`, `'Pa'`, `'N s'`, `'m'`). */
  readonly unit: string;
  readonly centring: Centring;
}

/** A field a solver touches, and how. A `write` makes the solver the field's one owner. */
export interface FieldUse {
  readonly field: FieldDescriptor;
  readonly access: FieldAccess;
  /**
   * A `read` the solver does without when no solver writes the field (default false): the world then runs it with no port
   * for the field in its step's inputs, where a field nobody writes is otherwise refused.
   */
  readonly optional?: boolean;
}

/**
 * A stretch of the world's shared memory: where it starts, how long it is, the type of its words and the version of its
 * layout. Solver state and ports are regions, so the world copies, restores and hashes them without knowing what they
 * hold, and a reader reads a port in place.
 */
export interface Region {
  /** A name unique within its solver (`'arena'`, `'particles'`, `'radiationMemory'`). */
  readonly name: string;
  /** Byte offset into the world's memory. */
  readonly byteOffset: number;
  /** Length in bytes, a whole number of elements. */
  readonly byteLength: number;
  readonly type: ElementType;
  /** The layout's version: a reader refuses a port whose layout it does not know, and a snapshot records it. */
  readonly layout: number;
  /**
   * The memory the region lies in when it is not the world's: transitional, for a solver whose module still owns its memory (the
   * soft kernel, and a rigid kernel whose Physics was not made on the world's arena; docs/physics-framework.md, section 3), and
   * removed once none does. A snapshot and the state hash read it and record nothing of it, so they do not change when the memory does.
   */
  readonly memory?: WebAssembly.Memory;
}

/**
 * An integer origin cell of a large world (docs/physics-framework.md, section 2, large worlds): positions are this cell
 * plus an f32 offset inside it. The world sets the cells; moving an origin changes only these integers, never a float of
 * state, and a coupling between solvers in different cells converts through the cell difference, which is exact.
 */
export type Cell = readonly [number, number, number];

/** A port: one field's data at a tick, published by its owner or gathered for an accumulator, as a region. */
export interface Port {
  readonly field: string;
  readonly region: Region;
  /** The tick the data is valid at, on the clock of the solver that published it. */
  readonly tick: number;
  /** The cell the port's positions are expressed in (set by the world). */
  readonly cell: Cell;
}

/** What a solver says about itself, before it is given any state: the coupling graph and the schedule are built from it. */
export interface SolverDescription {
  /** The solver's id, unique in a world; contributions to an accumulator are summed by this id, then by element. */
  readonly id: string;
  /** Every field it reads, writes or accumulates into. */
  readonly fields: readonly FieldUse[];
  /** The rate it prefers. */
  readonly rate: RateLevel;
  /**
   * Its stability limit as a function of its state: the slowest rate level it may step at now (a CFL bound, say). The
   * world runs it at the faster of this and `rate`. It must be a deterministic function of state, as the level becomes
   * part of state.
   */
  stableRate(): RateLevel;
}

/** What the world gives a solver when it is made: where its memory is and what it may allocate. */
export interface SolverHost {
  /** The world's shared memory, which every solver module imports. */
  readonly memory: WebAssembly.Memory;
  /** The world's gravity, m/s squared, the one value every solver uses (PA-08). */
  readonly gravity: readonly [number, number, number];
  /**
   * Assigns the solver a region of `byteLength` bytes of `type` words, zeroed. Allocating may grow the world's memory, which
   * detaches every typed-array view over it, its own and every other solver's: a solver takes its views after allocating and
   * makes them afresh at each use, never holding one across steps (KB-PHYS-REGISTRYGROW1).
   */
  allocate(name: string, byteLength: number, type: ElementType, layout: number): Region;
  /**
   * The solver's region `region` at `byteLength` bytes, its words kept up to the shorter length and the rest zeroed, in place
   * where it can be and else in a new place with one copy (the arena's `resize`). Use the region it returns, and list it in
   * `stateRegions()` from then on. Growing may grow the world's memory, as {@link SolverHost.allocate} may.
   */
  resize(region: Region, byteLength: number): Region;
  /** Gives back a region the solver no longer needs; a later region may take its bytes. */
  free(region: Region): void;
  /**
   * The world's body rows: how many records every body-set field holds (`bodies`, `bodyImpulses`, `bodyForces`,
   * `deckClaims`, one a kernel body row), the same for every solver that writes or adds to one. The world's `bodyRows`
   * option sets them; else the first solver that passes `atLeast` (the rigid solver, its kernel's capacity) fixes them. A solver
   * sizes its body-set regions by them, never by its own rows.
   * @throws MargoError `state` when they are not fixed yet and `atLeast` is not given (add the rigid solver first, or make
   * the world with `bodyRows`), or when they are fewer than `atLeast`.
   */
  bodyRows(atLeast?: number): number;
  /**
   * The port of field `field` at the current coupling tick: the owner's published data for a field the solver reads, and
   * the contributions summed in canonical order (by solver id, then element) for a field it owns and others accumulate into.
   * Undefined when nothing was published or accumulated.
   */
  port(field: string): Port | undefined;
}

/** What a solver's step is given besides its own state. */
export interface StepContext {
  /** The tick being stepped, at the solver's own rate level: tick `t` ends at time `(t + 1) / rateOf(level)` seconds. */
  readonly tick: number;
  readonly level: RateLevel;
  /** The world's seed; a solver keys its counter-based random numbers by it, its id, the tick, the element and a stream. */
  readonly seed: number;
  /** The ports it reads, by field name, valid at the coupling tick. */
  readonly inputs: ReadonlyMap<string, Port>;
  /** The solver's own origin cell: its state's positions are offsets from it (set by the world). */
  readonly cell: Cell;
}

/**
 * The contract of every solver (docs/physics-framework.md, section 5). The world calls, in schedule order: `importPorts`,
 * `step` (as many times as its rate asks per coupling interval), `exportPorts`. Strongly coupled solvers also take
 * `iterate` and `rollback`, which a world calls only for a solver in an iterated coupling group.
 */
export interface Solver<Params = unknown> {
  /** The fields it touches, its preferred rate and its stability limit. */
  describe(): SolverDescription;
  /** Allocates its state in regions `host` assigns, from `params`. Called once, before the first step. */
  init(host: SolverHost, params: Params): void;
  /** Advances its state by `dt` seconds: a pure function of its state, its input ports, `dt` and its random counter. */
  step(context: StepContext, dt: number): void;
  /**
   * Publishes the data of every field it writes or accumulates into, valid at `tick`. A contributor hands its accumulated
   * contribution over through its own port, which the world sums by contributor id and then by element into the owner's sum.
   */
  exportPorts(tick: number): readonly Port[];
  /** Reads what other solvers accumulated into the fields it owns for `tick` (impulses, sources), through `SolverHost.port`. */
  importPorts(tick: number): void;
  /** The regions that make up its state: the world snapshots, restores and hashes these, and nothing else of the solver. */
  stateRegions(): readonly Region[];
  /**
   * History beyond its state that a restored run needs to go on bit for bit: wave-radiation memory, predictor and
   * acceleration histories, impulses not yet delivered. Snapshotted and hashed with the state.
   */
  extraState(): readonly Region[];
  /** Re-runs the current tick from the start saved for it, for strong coupling. */
  iterate?(context: StepContext, dt: number): void;
  /** Returns its state to the start of the current tick. */
  rollback?(): void;
}
