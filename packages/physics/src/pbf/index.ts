import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { MAX_MEMORY_PAGES, regionWords } from '../world/memory.js';
import type {
  Cell,
  FieldDescriptor,
  FieldUse,
  Port,
  RateLevel,
  Region,
  Solver,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import { BODIES_FIELD, BODY_IMPULSES_FIELD, BODY_WORDS, bodyRowsOf, IMPULSE_WORDS } from '../world/solvers/rigid.js';
import {
  BOUNDARY_WORDS,
  SOLID_WORDS,
  type PbfBoundary,
  type PreparedBoundary,
  inputRangeError,
  inputTypeError,
  positive,
  prepareBoundary,
  vec,
  writeBoundaries,
} from './boundary.js';
import { bindPbfKernel, loadPbfKernel, type PbfKernel } from './kernel.js';

export type { PbfBoundary } from './boundary.js';

/** The versioned f64 particle record. */
export const PBF_LAYOUT = 1;
/** The words in a particle record: XYZ, velocity XYZ, density and mass. Zero mass marks an unused row. */
export const PBF_PARTICLE_WORDS = 8;

const ZERO: Cell = [0, 0, 0];
const ONE: Vec3 = [1, 1, 1];
const SETTINGS_WORDS = 22;
const WORK_WORDS = 17;
const BUCKET_WORDS = 4;
const STATS_WORDS = 6;

/** A material sample in the fluid cell. Particles share the configured rest volume. */
export interface PbfPoint {
  readonly position: Vec3;
  /** Initial velocity in m/s. Default zero. */
  readonly velocity?: Vec3;
}

/** The current particle position and velocity in SI, density in kg/m³ and mass in kg. */
export interface PbfReading {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly density: number;
  readonly mass: number;
}

/** Deterministic work and compression measures from the last world step. */
export interface PbfStatistics {
  readonly particles: number;
  readonly substeps: number;
  readonly projections: number;
  readonly pairEvaluations: number;
  readonly peakCompression: number;
  readonly maximumSpeed: number;
}

export interface PbfOptions {
  /** World solver ID. Default `pbf`. */
  readonly id?: string;
  /** Exchange poses and impulses with the world's RigidSolver. Default false. */
  readonly rigid?: boolean;
  /** Dyadic world rate level (0 is 60 Hz). Default 0. */
  readonly rate?: RateLevel;
  readonly signal?: AbortSignal;
}

/** Settings for the preview or higher-iteration position-based liquid. */
export interface PbfParams {
  /** Initial points. Default empty. */
  readonly particles?: readonly PbfPoint[];
  /** Reserved point rows for later emission. Defaults to the number of initial points. */
  readonly capacity?: number;
  /** Mean particle spacing, metres. Default 0.06. Each row has this cube of rest volume. */
  readonly spacing?: number;
  /** Kernel radius, metres. Defaults to twice the particle spacing. */
  readonly support?: number;
  /** Contact radius, metres. Defaults to half the particle spacing. */
  readonly radius?: number;
  /** Rest density, kg/m³. Default 1,000. */
  readonly density?: number;
  /** Lower and upper bounds, metres in the solver cell. Default unit box. */
  readonly bounds?: readonly [lower: Vec3, upper: Vec3];
  /** Closed faces `[−X,+X,−Y,+Y,−Z,+Z]`. Default all true. Open faces keep water in the particle set. */
  readonly walls?: readonly [boolean, boolean, boolean, boolean, boolean, boolean];
  /** Fast mode uses four density iterations, precise mode twelve. Default `fast`. */
  readonly profile?: 'fast' | 'precise';
  /** Override the projection iterations per advective substep. */
  readonly iterations?: number;
  /** Nondimensional constraint mixing. Default 0.02. */
  readonly relaxation?: number;
  /** Nondimensional PBF artificial pressure at 60 Hz. Default 0.001. */
  readonly tensile?: number;
  /** Reference distance as a fraction of support. Default 0.3. */
  readonly tensileDistance?: number;
  /** Use signed density correction for stylized cohesion. Default false for free-water pressure. */
  readonly cohesive?: boolean;
  /** XSPH smoothing fraction per advective substep. Default 0.01. */
  readonly viscosity?: number;
  /** Vorticity confinement in m/s, limited by smoothing loss. Default zero. */
  readonly vorticity?: number;
  /** Tangential velocity removed by a contact, from 0 to 1. Default 0.1. */
  readonly friction?: number;
  /** Relative early-exit threshold with neither artificial pressure nor cohesion. Default 0. */
  readonly tolerance?: number;
  /** Fixed or body-attached solid boundaries. Default none. */
  readonly boundaries?: readonly PbfBoundary[];
  /** Optional assertion of the body's world-wide row capacity. Defaults to the world's registered count. */
  readonly bodyCapacity?: number;
  /** metres per world origin cell. Default 4096. */
  readonly cellSize?: number;
}

type State = {
  readonly host: SolverHost;
  readonly kernel: PbfKernel;
  readonly points: Region;
  readonly scratch: Region;
  readonly stats: Region;
  readonly settings: Region;
  readonly buckets: Region;
  readonly next: Region;
  readonly used: Region;
  readonly boundary: Region;
  readonly shapes: Region;
  readonly impulses: Region;
  readonly pressureImpulses: Region;
  readonly surfaces: readonly PreparedBoundary[];
  readonly bodyCapacity: number;
  readonly sampleCount: number;
  readonly bucketCount: number;
  readonly capacity: number;
  readonly mass: number;
  readonly cellSize: number;
};

function whole(value: number, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw inputRangeError(`${label} is outside its range. Pass an integer of at least ${minimum}.`);
  return value;
}

function fraction(value: number, label: string, maximum = 1): number {
  if (!Number.isFinite(value) || value < 0 || value > maximum)
    throw inputRangeError(`${label} is out of range. Pass a value between zero and ${maximum}.`);
  return value;
}

const numbers = (state: State, region: Region) => regionWords(state.host.memory, region) as Float64Array;
const xyz = (values: Float64Array, at: number): Vec3 => [values[at]!, values[at + 1]!, values[at + 2]!];

/** Clocked, native position-based fluid for free surfaces, pours and splashes. */
export class PbfSolver implements Solver<PbfParams> {
  readonly particleField: FieldDescriptor;
  private state?: State;
  private cell: Cell = ZERO;

  private constructor(
    readonly id: string,
    private readonly module: WebAssembly.Module,
    private readonly memory: WebAssembly.Memory,
    private readonly rigid: boolean,
    private readonly preferredRate: RateLevel,
  ) {
    this.particleField = {
      name: `${id}:particles`,
      kind: 'particleSet',
      quantity: 'position, velocity, density, mass',
      unit: 'm, m/s, kg/m³, kg',
      centring: 'particle',
    };
  }

  /** Load the optional plain or shared Wasm for this world's memory. */
  static async load(memory: WebAssembly.Memory, options: PbfOptions = {}): Promise<PbfSolver> {
    const rate = whole(options.rate ?? 0, 0, 'PBF rate');
    if (rate > 7)
      throw inputRangeError('PBF rate level is outside the world clock. Choose a dyadic level from 0 to 7.');
    const module = await loadPbfKernel(memory, options.signal);
    return new PbfSolver(options.id ?? 'pbf', module, memory, options.rigid ?? false, rate as RateLevel);
  }

  describe() {
    const fields: FieldUse[] = [{ field: this.particleField, access: 'write' }];
    if (this.rigid)
      fields.push({ field: BODIES_FIELD, access: 'read' }, { field: BODY_IMPULSES_FIELD, access: 'accumulate' });
    return { id: this.id, rate: this.preferredRate, stableRate: () => this.preferredRate, fields };
  }

  init(host: SolverHost, params: PbfParams = {}): void {
    if (this.state)
      throw new MargoError('state', 'This PBF solver owns a world already. Load a new instance for the second solver.');
    const spacing = positive(params.spacing ?? 0.06, 'PBF spacing');
    const support = positive(params.support ?? 2 * spacing, 'PBF support');
    const radius = positive(params.radius ?? 0.5 * spacing, 'PBF contact radius');
    const density = positive(params.density ?? 1000, 'PBF rest density');
    const mass = positive(density * spacing * spacing * spacing, 'PBF particle mass');
    const massScale = positive(density * support * support * support, 'PBF kernel mass scale');
    positive(1 / massScale, 'PBF inverse kernel mass scale');
    const lower = vec(params.bounds?.[0] ?? ZERO, 'PBF lower bounds');
    const upper = vec(params.bounds?.[1] ?? ONE, 'PBF upper bounds');
    for (let k = 0; k < 3; k++) {
      const span = upper[k]! - lower[k]!;
      if (!Number.isFinite(span) || span < 2 * radius)
        throw inputRangeError('PBF bounds cannot hold a particle. Widen the bounds or reduce the contact radius.');
    }
    if (params.profile !== undefined && params.profile !== 'fast' && params.profile !== 'precise')
      throw inputTypeError('PBF profile is unknown. Choose fast or precise.');
    const iterations = whole(params.iterations ?? (params.profile === 'precise' ? 12 : 4), 1, 'PBF iterations');
    const walls = params.walls ?? [true, true, true, true, true, true];
    if (walls.length !== 6 || !walls.every((value) => typeof value === 'boolean'))
      throw inputTypeError('PBF walls must name six faces. Pass six boolean values in min/max XYZ order.');
    const mask = walls.reduce((flags, closed, index) => flags + (closed ? 1 << index : 0), 0);
    const boundaries = params.boundaries ?? [];
    const rows = boundaries.flatMap(({ body }) => (body === undefined ? [] : [body]));
    const bodyCapacity = this.rigid ? bodyRowsOf(host, this.id, rows, params.bodyCapacity) : 0;
    const surfaces = boundaries.map((b) => prepareBoundary(b, spacing, support, bodyCapacity));
    const sampleCount = surfaces.reduce((sum, surface) => sum + surface.samples.length, 0);
    const particles = params.particles ?? [];
    const capacity = whole(params.capacity ?? particles.length, particles.length, 'PBF particle capacity');
    const words = Math.max(1, capacity);
    let bucketCount = 2;
    while (bucketCount < 2 * (capacity + sampleCount)) bucketCount *= 2;
    const bytes =
      8 *
        ((3 * PBF_PARTICLE_WORDS + WORK_WORDS) * words +
          BOUNDARY_WORDS * sampleCount +
          SOLID_WORDS * surfaces.length +
          2 * IMPULSE_WORDS * bodyCapacity) +
      4 * (bucketCount * BUCKET_WORDS + 2 * (capacity + sampleCount));
    if (bytes >= MAX_MEMORY_PAGES * 65536)
      throw inputRangeError(
        'PBF grid and state exceed the wasm32 arena. Reserve fewer points or use coarser boundary sampling.',
      );
    const settings = [
      ...host.gravity,
      ...lower,
      ...upper,
      support,
      density,
      radius,
      positive(params.relaxation ?? 0.02, 'PBF relaxation'),
      fraction(params.tensile ?? 0.001, 'PBF artificial pressure'),
      fraction(params.tensileDistance ?? 0.3, 'PBF tensile reference distance', 0.5),
      fraction(params.viscosity ?? 0.01, 'PBF viscosity'),
      fraction(params.vorticity ?? 0, 'PBF vorticity', Number.MAX_VALUE),
      fraction(params.friction ?? 0.1, 'PBF friction'),
      iterations,
      fraction(params.tolerance ?? 0, 'PBF compression tolerance'),
      mask,
      params.cohesive ? 1 : 0,
    ];
    const f64 = (name: string, count: number) => host.allocate(name, Math.max(1, count) * 8, 'f64', PBF_LAYOUT);
    const state: State = {
      host,
      capacity,
      bodyCapacity,
      sampleCount,
      bucketCount,
      surfaces,
      mass,
      cellSize: positive(params.cellSize ?? 4096, 'PBF cell size'),
      kernel: bindPbfKernel(host, this.module, this.memory),
      points: f64('pbf-particles', words * PBF_PARTICLE_WORDS),
      scratch: f64('pbf-workspace', words * WORK_WORDS),
      settings: f64('pbf-settings', SETTINGS_WORDS),
      stats: f64('pbf-statistics', STATS_WORDS),
      buckets: host.allocate('pbf-neighbour-buckets', bucketCount * BUCKET_WORDS * 4, 'u32', PBF_LAYOUT),
      next: host.allocate('pbf-neighbour-links', Math.max(1, words + sampleCount) * 4, 'u32', PBF_LAYOUT),
      used: host.allocate('pbf-occupied-buckets', Math.max(1, words + sampleCount) * 4, 'u32', PBF_LAYOUT),
      boundary: f64('pbf-boundaries', sampleCount * BOUNDARY_WORDS),
      shapes: f64('pbf-solids', surfaces.length * SOLID_WORDS),
      impulses: f64('pbf-body-impulses', bodyCapacity * IMPULSE_WORDS),
      pressureImpulses: f64('pbf-pressure-impulses', bodyCapacity * IMPULSE_WORDS),
    };
    this.state = state;
    numbers(state, state.settings).set(settings);
    this.emit(particles);
    this.updateBoundaries(host.port(BODIES_FIELD.name));
    this.run(0);
  }

  /** Append new material at a world tick boundary, returning its first row. Empty input leaves the state unchanged. */
  emit(points: readonly PbfPoint[]): number {
    const state = this.ready();
    const stats = numbers(state, state.stats);
    const first = stats[0]!;
    const current = first + points.length;
    if (current > state.capacity)
      throw new MargoError(
        'state',
        'The PBF emitter exceeded its reserved rows. Increase particle capacity or emit fewer particles.',
      );
    const input = points.map(
      ({ position, velocity }) =>
        [vec(position, 'PBF point position'), vec(velocity ?? ZERO, 'PBF point velocity')] as const,
    );
    const out = numbers(state, state.points);
    for (let i = 0; i < input.length; i++) {
      const [position, velocity] = input[i]!;
      out.set([...position, ...velocity, 0, state.mass], (first + i) * PBF_PARTICLE_WORDS);
    }
    stats[0] = current;
    return first;
  }

  private updateBoundaries(port: Port | undefined): void {
    const state = this.ready();
    if (!state.surfaces.length) return;
    if (
      port &&
      (port.region.type !== 'f32' ||
        port.region.layout !== 2 ||
        port.region.byteLength !== state.bodyCapacity * BODY_WORDS * 4)
    )
      throw new MargoError(
        'state',
        'PBF cannot read this bodies port. Use the same body capacity as the layout-2 RigidSolver.',
      );
    const bodies = port && (regionWords(state.host.memory, port.region) as Float32Array);
    writeBoundaries(
      state.surfaces,
      numbers(state, state.shapes),
      numbers(state, state.boundary),
      bodies,
      this.cell,
      port?.cell ?? this.cell,
      state.cellSize,
    );
  }

  private run(dt: number): void {
    const state = this.ready();
    const count = numbers(state, state.stats)[0]!;
    if (!count) return;
    const error = state.kernel.solve_pbf(
      state.points.byteOffset,
      count,
      state.scratch.byteOffset,
      state.buckets.byteOffset,
      state.bucketCount,
      state.next.byteOffset,
      state.used.byteOffset,
      state.boundary.byteOffset,
      state.sampleCount,
      state.shapes.byteOffset,
      state.surfaces.length,
      state.impulses.byteOffset,
      state.pressureImpulses.byteOffset,
      state.bodyCapacity,
      state.settings.byteOffset,
      state.stats.byteOffset,
      dt,
    );
    if (error)
      throw new MargoError(
        'failed',
        'PBF cannot resolve travel in one world step. Increase resolution in time or reduce velocity.',
      );
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    this.updateBoundaries(context.inputs.get(BODIES_FIELD.name));
    this.run(dt);
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const state = this.ready();
    const ports = [{ field: this.particleField.name, region: state.points, tick, cell: this.cell }];
    if (this.rigid) ports.push({ field: BODY_IMPULSES_FIELD.name, region: state.impulses, tick, cell: this.cell });
    return ports;
  }

  stateRegions(): readonly Region[] {
    const state = this.ready();
    return [state.points, state.stats, state.impulses];
  }

  extraState(): readonly Region[] {
    return [];
  }

  get statistics(): PbfStatistics {
    const state = this.ready();
    const s = numbers(state, state.stats);
    return {
      particles: s[0]!,
      substeps: s[1]!,
      projections: s[2]!,
      pairEvaluations: s[3]!,
      peakCompression: s[4]!,
      maximumSpeed: s[5]!,
    };
  }

  get mass(): number {
    const state = this.ready();
    return state.mass * numbers(state, state.stats)[0]!;
  }

  sample(index: number): PbfReading {
    const state = this.ready();
    if (!Number.isSafeInteger(index) || index < 0 || index >= numbers(state, state.stats)[0]!)
      throw inputRangeError('PBF point is outside the active rows. Choose a valid sample index.');
    const out = numbers(state, state.points);
    const at = index * PBF_PARTICLE_WORDS;
    return { position: xyz(out, at), velocity: xyz(out, at + 3), density: out[at + 6]!, mass: out[at + 7]! };
  }

  /** Copy tightly packed XYZ into staging storage for a renderer. */
  positions(out?: Float32Array): Float32Array {
    const state = this.ready();
    const count = numbers(state, state.stats)[0]!;
    const buffer = out ?? new Float32Array(count * 3);
    if (buffer.length < count * 3)
      throw inputRangeError('PBF position buffer is too short. Provide three floats per active point.');
    const rows = numbers(state, state.points);
    for (let i = 0; i < count; i++) {
      const from = i * PBF_PARTICLE_WORDS;
      buffer[3 * i] = rows[from]!;
      buffer[3 * i + 1] = rows[from + 1]!;
      buffer[3 * i + 2] = rows[from + 2]!;
    }
    return buffer.subarray(0, count * 3);
  }

  private ready(): State {
    if (!this.state) throw new MargoError('state', 'PBF has no arena. Add it to a PhysicsWorld before using it.');
    return this.state;
  }
}
