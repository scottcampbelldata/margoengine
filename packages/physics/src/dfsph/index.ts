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
  type PbfBoundary as ParticleBoundary,
  type PreparedBoundary,
  positive,
  prepareBoundary,
  vec,
  writeBoundaries,
} from '../pbf/boundary.js';
import {
  DFSPH_PARCEL_LAYOUT,
  DFSPH_PARCEL_WORDS,
  type DfsphParcelFields,
  exchangeParcels,
  getParcels,
  parcelFields,
} from './exchange.js';
import { bindDfsphKernel, loadDfsphKernel } from './kernel.js';

export { DFSPH_PARCEL_LAYOUT, DFSPH_PARCEL_WORDS, type DfsphParcelFields } from './exchange.js';
export type { PbfBoundary as DfsphBoundary } from '../pbf/boundary.js';

/** The versioned f64 particle record. */
export const DFSPH_LAYOUT = 1;
/** The words in a particle record: XYZ, velocity XYZ, density and mass. Zero mass marks an unused row. */
export const DFSPH_PARTICLE_WORDS = 8;

const ZERO: Cell = [0, 0, 0];
const ONE: Vec3 = [1, 1, 1];
const SETTINGS_WORDS = 26;
const WORK_WORDS = 29;
const BUCKET_WORDS = 4;
const STATS_WORDS = 10;
const MODAL_WORDS = 5;
const CUBIC = 8 / Math.PI;

/** A material sample in the fluid cell. Particles share the configured rest volume. */
export interface DfsphPoint {
  readonly position: Vec3;
  /** Initial velocity in m/s. Default zero. */
  readonly velocity?: Vec3;
}

/** The current particle position and velocity in SI, density in kg/m³ and mass in kg. */
export interface DfsphReading {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly density: number;
  readonly mass: number;
}

/** Deterministic work and compression measures from the last world step. */
export interface DfsphStatistics {
  readonly particles: number;
  readonly substeps: number;
  readonly densityIterations: number;
  readonly divergenceIterations: number;
  readonly viscosityIterations: number;
  readonly pairEvaluations: number;
  /** Mean positive predicted excess density as a fraction of rest density. */
  readonly compression: number;
  /** Mean positive normalized density rate, s⁻¹. */
  readonly divergence: number;
  readonly maximumSpeed: number;
}

export interface DfsphOptions {
  /** World solver ID. Default `dfsph`. */
  readonly id?: string;
  /** Exchange poses and impulses with the world's RigidSolver. Default false. */
  readonly rigid?: boolean;
  /** Dyadic world rate level (0 is 60 Hz). Default 0. */
  readonly rate?: RateLevel;
  /** Optional one-track contactField of a ModalSoundSolver on the same world rate. */
  readonly modalContactField?: FieldDescriptor;
  /** Whole-particle parcel requests this clock step. Default zero disables the exchange fields. */
  readonly parcelCapacity?: number;
  readonly signal?: AbortSignal;
}

/** Material, boundaries and convergence settings for the divergence-free SPH liquid. */
export interface DfsphParams {
  /** Initial points. Default empty. */
  readonly particles?: readonly DfsphPoint[];
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
  /** Include the planar wall kernel integral in pressure. Default true. Hard contacts are always active on closed faces. */
  readonly wallPressure?: boolean;
  /** Liquid–air surface tension in N/m. Default zero. Set 0.07274 for pure water at 20 °C. */
  readonly surfaceTension?: number;
  /** Solid–liquid interface energy in N/m. Default zero. */
  readonly solidLiquidTension?: number;
  /** Solid–air interface energy in N/m. Default zero. Higher values favour wetting. */
  readonly solidVaporTension?: number;
  /** Interactive caps both pressure passes at 12 iterations. Accurate allows 40 density and 32 divergence. Default accurate. */
  readonly profile?: 'interactive' | 'accurate';
  /** Maximum density iterations per advective substep. Overrides the profile. */
  readonly densityIterations?: number;
  /** Maximum divergence iterations per advective substep. Overrides the profile. */
  readonly divergenceIterations?: number;
  /** Relative mean positive density error. Defaults to 0.0001 accurate or 0.001 interactive. */
  readonly densityTolerance?: number;
  /** Mean positive normalized density rate in s⁻¹. Defaults to 0.1 accurate or 0.5 interactive. */
  readonly divergenceTolerance?: number;
  /** Warm start both pressure passes from the previous substep. Default true. */
  readonly warmStart?: boolean;
  /** Kinematic viscosity, m²/s. Default 10⁻⁶ (fresh water near 20 °C). */
  readonly viscosity?: number;
  /** Maximum implicit viscosity iterations per substep. Default 32 accurate or 12 interactive. */
  readonly viscosityIterations?: number;
  /** Fraction of tangential speed removed by inward contact. Default 0.1. */
  readonly friction?: number;
  /** Fixed or body-attached solid boundaries. Default none. */
  readonly boundaries?: readonly ParticleBoundary[];
  /** Optional assertion of the body's world-wide row capacity. Defaults to the world's registered count. */
  readonly bodyCapacity?: number;
  /** metres per world origin cell. Default 4096. */
  readonly cellSize?: number;
}

type State = {
  readonly host: SolverHost;
  readonly kernel: ReturnType<typeof bindDfsphKernel>;
  readonly points: Region;
  readonly scratch: Region;
  readonly stats: Region;
  readonly settings: Region;
  readonly modal?: Region;
  readonly parcels?: { readonly receipts: Region; readonly clock: Region };
  readonly buckets: Region;
  readonly next: Region;
  readonly used: Region;
  readonly boundary: Region;
  readonly boundaryColor: Region;
  readonly shapes: Region;
  readonly impulses: Region;
  readonly pressureImpulses: Region;
  readonly surfaces: readonly PreparedBoundary[];
  readonly bodyCapacity: number;
  readonly sampleCount: number;
  readonly bucketCount: number;
  readonly capacity: number;
  readonly mass: number;
  readonly volume: number;
  readonly cellSize: number;
};

function whole(value: number, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`${label} is outside its range. Pass an integer of at least ${minimum}.`);
  return value;
}

function fraction(value: number, label: string, maximum = 1): number {
  if (!Number.isFinite(value) || value < 0 || value > maximum)
    throw new RangeError(`${label} is out of range. Pass a value between zero and ${maximum}.`);
  return value;
}

function cubicWeight(x: number, y: number, z: number): number {
  const distanceSquared = x * x + y * y + z * z;
  if (distanceSquared >= 1) return 0;
  const q = Math.sqrt(distanceSquared);
  if (q < 0.5) return 1 - 6 * q * q * (1 - q);
  const remainder = 1 - q;
  return 2 * remainder * remainder * remainder;
}

const numbers = (state: State, region: Region) => regionWords(state.host.memory, region) as Float64Array;
const xyz = (values: Float64Array, at: number): Vec3 => [values[at]!, values[at + 1]!, values[at + 2]!];

/** Clocked, native divergence-free SPH with independent density and velocity-divergence pressure. */
export class DfsphSolver implements Solver<DfsphParams> {
  readonly particleField: FieldDescriptor;
  /** Present when parcelCapacity is positive. Install the other endpoint at the same dyadic rate. */
  readonly parcelFields?: DfsphParcelFields;
  private state?: State;
  private cell: Cell = ZERO;

  private constructor(
    readonly id: string,
    private readonly module: WebAssembly.Module,
    private readonly memory: WebAssembly.Memory,
    private readonly rigid: boolean,
    private readonly preferredRate: RateLevel,
    private readonly parcelCapacity: number,
    private readonly modalContactField?: FieldDescriptor,
  ) {
    if (parcelCapacity) this.parcelFields = parcelFields(id);
    this.particleField = {
      name: `${id}:particles`,
      kind: 'particleSet',
      quantity: 'position, velocity, density, mass',
      unit: 'm, m/s, kg/m³, kg',
      centring: 'particle',
    };
  }

  /** Load the optional plain or shared Wasm for this world's memory. */
  static async load(memory: WebAssembly.Memory, options: DfsphOptions = {}): Promise<DfsphSolver> {
    const rate = whole(options.rate ?? 0, 0, 'DFSPH rate');
    if (rate > 7)
      throw new RangeError('DFSPH rate level is outside the world clock. Choose a dyadic level from 0 to 7.');
    const modal = options.modalContactField;
    if (
      modal &&
      (modal.kind !== 'scalarSeries' ||
        modal.quantity !== 'modalContactLoad' ||
        modal.unit !== 'N s, W, W m/s, W, W m/s' ||
        modal.centring !== 'cell')
    )
      throw new TypeError('DFSPH modal output requires a compatible field. Pass the ModalSoundSolver contactField.');
    const module = await loadDfsphKernel(memory, options.signal);
    return new DfsphSolver(
      options.id ?? 'dfsph',
      module,
      memory,
      options.rigid ?? false,
      rate as RateLevel,
      whole(options.parcelCapacity ?? 0, 0, 'DFSPH parcel capacity'),
      modal ? Object.freeze({ ...modal }) : undefined,
    );
  }

  describe() {
    const fields: FieldUse[] = [{ field: this.particleField, access: 'write' }];
    if (this.rigid)
      fields.push({ field: BODIES_FIELD, access: 'read' }, { field: BODY_IMPULSES_FIELD, access: 'accumulate' });
    if (this.modalContactField) fields.push({ field: this.modalContactField, access: 'write' });
    if (this.parcelFields)
      fields.push(
        { field: this.parcelFields.requests, access: 'read' },
        { field: this.parcelFields.receipts, access: 'write' },
      );
    return { id: this.id, rate: this.preferredRate, stableRate: () => this.preferredRate, fields };
  }

  init(host: SolverHost, params: DfsphParams = {}): void {
    if (this.state)
      throw new MargoError(
        'state',
        'This DFSPH solver owns a world already. Load a new instance for the second solver.',
      );
    const spacing = positive(params.spacing ?? 0.06, 'DFSPH spacing');
    const support = positive(params.support ?? 2 * spacing, 'DFSPH support');
    const radius = positive(params.radius ?? 0.5 * spacing, 'DFSPH contact radius');
    const density = positive(params.density ?? 1000, 'DFSPH rest density');
    const mass = positive(density * spacing * spacing * spacing, 'DFSPH particle mass');
    const massScale = positive(density * support * support * support, 'DFSPH kernel mass scale');
    positive(1 / massScale, 'DFSPH inverse kernel mass scale');
    const lower = vec(params.bounds?.[0] ?? ZERO, 'DFSPH lower bounds');
    const upper = vec(params.bounds?.[1] ?? ONE, 'DFSPH upper bounds');
    for (let k = 0; k < 3; k++) {
      const span = upper[k]! - lower[k]!;
      if (!Number.isFinite(span) || span < 2 * radius)
        throw new RangeError('DFSPH bounds cannot hold a particle. Widen the bounds or reduce the contact radius.');
    }
    if (params.profile !== undefined && params.profile !== 'interactive' && params.profile !== 'accurate')
      throw new TypeError('DFSPH profile is unknown. Choose interactive or accurate.');
    const interactive = params.profile === 'interactive';
    const densityIterations = whole(params.densityIterations ?? (interactive ? 12 : 40), 1, 'DFSPH density iterations');
    const divergenceIterations = whole(
      params.divergenceIterations ?? (interactive ? 12 : 32),
      1,
      'DFSPH divergence iterations',
    );
    const viscosityIterations = whole(
      params.viscosityIterations ?? (interactive ? 12 : 32),
      1,
      'DFSPH viscosity iterations',
    );
    if (Math.max(densityIterations, divergenceIterations, viscosityIterations) >= 0x1_0000_0000)
      throw new RangeError('DFSPH iteration count exceeds wasm32. Pass a count below 2³².');
    const viscosity = fraction(params.viscosity ?? 0.000001, 'DFSPH kinematic viscosity', Number.MAX_VALUE);
    if (!Number.isFinite(viscosity / (support * support)))
      throw new RangeError('DFSPH viscosity scale overflows. Reduce viscosity or increase kernel support.');
    const walls = params.walls ?? [true, true, true, true, true, true];
    if (walls.length !== 6 || !walls.every((value) => typeof value === 'boolean'))
      throw new TypeError('DFSPH walls must name six faces. Pass six boolean values in min/max XYZ order.');
    const mask = walls.reduce((flags, closed, index) => flags + (closed ? 1 << index : 0), 0);
    const boundaries = params.boundaries ?? [];
    const rows = boundaries.flatMap(({ body }) => (body === undefined ? [] : [body]));
    const bodyCapacity = this.rigid ? bodyRowsOf(host, this.id, rows, params.bodyCapacity) : 0;
    const surfaces = boundaries.map((b) => prepareBoundary(b, spacing, support, bodyCapacity, cubicWeight, CUBIC));
    const sampleCount = surfaces.reduce((sum, surface) => sum + surface.samples.length, 0);
    const liquidVapor = fraction(params.surfaceTension ?? 0, 'DFSPH surface tension', Number.MAX_VALUE);
    const solidLiquid = fraction(params.solidLiquidTension ?? 0, 'DFSPH solid–liquid tension', Number.MAX_VALUE);
    const solidVapor = fraction(params.solidVaporTension ?? 0, 'DFSPH solid–air tension', Number.MAX_VALUE);
    const capillary = Math.max(liquidVapor, solidLiquid, solidVapor) > 0;
    if (capillary) {
      const reach = positive(3 * spacing, 'DFSPH surface kernel support');
      positive(1 / (density * reach * reach * reach), 'DFSPH inverse surface kernel mass scale');
    }
    const particles = params.particles ?? [];
    const capacity = whole(params.capacity ?? particles.length, particles.length, 'DFSPH particle capacity');
    const words = Math.max(1, capacity);
    let bucketCount = 2;
    while (bucketCount < 2 * (capacity + sampleCount)) bucketCount *= 2;
    const bytes =
      8 *
        ((3 * DFSPH_PARTICLE_WORDS + WORK_WORDS) * words +
          (BOUNDARY_WORDS + Number(capillary)) * sampleCount +
          SOLID_WORDS * surfaces.length +
          2 * IMPULSE_WORDS * bodyCapacity) +
      4 * (bucketCount * BUCKET_WORDS + 2 * (capacity + sampleCount)) +
      this.parcelCapacity * DFSPH_PARCEL_WORDS * 8;
    if (bytes >= MAX_MEMORY_PAGES * 65536)
      throw new RangeError(
        'DFSPH grid and state exceed the wasm32 arena. Reserve fewer points or use coarser boundary sampling.',
      );
    const settings = [
      ...host.gravity,
      ...lower,
      ...upper,
      support,
      density,
      radius,
      spacing,
      fraction(params.densityTolerance ?? (interactive ? 0.001 : 0.0001), 'DFSPH density tolerance'),
      fraction(params.divergenceTolerance ?? (interactive ? 0.5 : 0.1), 'DFSPH divergence tolerance', Number.MAX_VALUE),
      viscosity,
      fraction(params.friction ?? 0.1, 'DFSPH friction'),
      densityIterations,
      divergenceIterations,
      mask,
      (params.warmStart ?? true) ? 1 : 0,
      viscosityIterations,
      (params.wallPressure ?? true) ? 1 : 0,
      liquidVapor,
      solidLiquid,
      solidVapor,
    ];
    const f64 = (name: string, count: number) => host.allocate(name, Math.max(1, count) * 8, 'f64', DFSPH_LAYOUT);
    const state: State = {
      host,
      capacity,
      bodyCapacity,
      sampleCount,
      bucketCount,
      surfaces,
      mass,
      volume: positive(mass / density, 'DFSPH particle volume'),
      cellSize: positive(params.cellSize ?? 4096, 'DFSPH cell size'),
      kernel: bindDfsphKernel(host, this.module, this.memory),
      points: f64('dfsph-particles', words * DFSPH_PARTICLE_WORDS),
      scratch: f64('dfsph-workspace', words * WORK_WORDS),
      settings: f64('dfsph-settings', SETTINGS_WORDS),
      stats: f64('dfsph-statistics', STATS_WORDS),
      modal: this.modalContactField && f64('dfsph-modal-impact', MODAL_WORDS),
      parcels: this.parcelFields && {
        clock: f64('dfsph-parcel-request-clock', 2),
        receipts: f64('dfsph-parcel-receipts', this.parcelCapacity * DFSPH_PARCEL_WORDS),
      },
      buckets: host.allocate('dfsph-neighbour-buckets', bucketCount * BUCKET_WORDS * 4, 'u32', DFSPH_LAYOUT),
      next: host.allocate('dfsph-neighbour-links', Math.max(1, words + sampleCount) * 4, 'u32', DFSPH_LAYOUT),
      used: host.allocate('dfsph-occupied-buckets', Math.max(1, words + sampleCount) * 4, 'u32', DFSPH_LAYOUT),
      boundary: f64('dfsph-boundaries', sampleCount * BOUNDARY_WORDS),
      boundaryColor: f64('dfsph-boundary-interface', capillary ? sampleCount : 0),
      shapes: f64('dfsph-solids', surfaces.length * SOLID_WORDS),
      impulses: f64('dfsph-body-impulses', bodyCapacity * IMPULSE_WORDS),
      pressureImpulses: f64('dfsph-pressure-impulses', bodyCapacity * IMPULSE_WORDS),
    };
    this.state = state;
    if (state.parcels) numbers(state, state.parcels.clock)[0] = -1;
    numbers(state, state.settings).set(settings);
    this.emit(particles);
    this.updateBoundaries(host.port(BODIES_FIELD.name));
    this.run(0);
  }

  /** Append new material at a world tick boundary, returning its first row. Empty input leaves the state unchanged. */
  emit(points: readonly DfsphPoint[]): number {
    const state = this.ready();
    const stats = numbers(state, state.stats);
    const first = stats[0]!;
    const current = first + points.length;
    if (current > state.capacity)
      throw new MargoError(
        'state',
        'The DFSPH emitter exceeded its reserved rows. Increase particle capacity or emit fewer particles.',
      );
    const input = points.map(
      ({ position, velocity }) =>
        [vec(position, 'DFSPH point position'), vec(velocity ?? ZERO, 'DFSPH point velocity')] as const,
    );
    const out = numbers(state, state.points);
    for (let i = 0; i < input.length; i++) {
      const [position, velocity] = input[i]!;
      out.set([...position, ...velocity, 0, state.mass], (first + i) * DFSPH_PARTICLE_WORDS);
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
        'DFSPH cannot read this bodies port. Use the same body capacity as the layout-2 RigidSolver.',
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
    const error = state.kernel(
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
      state.boundaryColor.byteOffset,
    );
    if (error)
      throw new MargoError(
        'failed',
        'DFSPH cannot resolve travel in one world step. Increase resolution in time or reduce velocity.',
      );
  }

  private applyParcels(input: Port | undefined): void {
    const state = this.ready();
    if (!state.parcels || !input) return;
    const { region, tick, cell } = input;
    const clock = numbers(state, state.parcels.clock);
    if (tick <= clock[0]!) return;
    if (
      region.layout !== DFSPH_PARCEL_LAYOUT ||
      region.type !== 'f64' ||
      region.byteLength !== this.parcelCapacity * DFSPH_PARCEL_WORDS * 8
    )
      throw new MargoError(
        'state',
        'Incompatible DFSPH parcel requests. Provide the configured number of layout-1 f64 parcel rows.',
      );
    const shift: Cell = [
      (cell[0] - this.cell[0]) * state.cellSize,
      (cell[1] - this.cell[1]) * state.cellSize,
      (cell[2] - this.cell[2]) * state.cellSize,
    ];
    const requests = getParcels(numbers(state, region), state.volume, state.mass, shift, clock[1]!);
    if (requests.length) {
      const receipts = numbers(state, state.parcels.receipts);
      const stats = numbers(state, state.stats);
      stats[0] = exchangeParcels(
        numbers(state, state.points),
        numbers(state, state.scratch),
        stats[0]!,
        state.capacity,
        DFSPH_PARTICLE_WORDS,
        WORK_WORDS,
        state.mass,
        requests,
        receipts,
      );
      clock[1] = requests.at(-1)!.ticket;
    }
    clock[0] = tick;
  }

  step(context: StepContext, dt: number): void {
    this.cell = context.cell;
    if (this.parcelFields) this.applyParcels(context.inputs.get(this.parcelFields.requests.name));
    this.updateBoundaries(context.inputs.get(BODIES_FIELD.name));
    this.run(dt);
    const state = this.ready();
    if (state.modal) numbers(state, state.modal)[0] = numbers(state, state.stats)[9]!;
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const state = this.ready();
    const ports = [{ field: this.particleField.name, region: state.points, tick, cell: this.cell }];
    if (this.rigid) ports.push({ field: BODY_IMPULSES_FIELD.name, region: state.impulses, tick, cell: this.cell });
    if (state.modal && this.modalContactField)
      ports.push({ field: this.modalContactField.name, region: state.modal, tick, cell: this.cell });
    if (this.parcelFields && state.parcels)
      ports.push({ field: this.parcelFields.receipts.name, region: state.parcels.receipts, tick, cell: this.cell });
    return ports;
  }

  stateRegions(): readonly Region[] {
    const state = this.ready();
    const regions = [state.points, state.stats, state.impulses];
    if (state.modal) regions.push(state.modal);
    if (state.parcels) regions.push(state.parcels.clock, state.parcels.receipts);
    return regions;
  }

  extraState(): readonly Region[] {
    return [this.ready().scratch];
  }

  get statistics(): DfsphStatistics {
    const state = this.ready();
    const s = numbers(state, state.stats);
    return {
      particles: s[0]!,
      substeps: s[1]!,
      densityIterations: s[2]!,
      divergenceIterations: s[3]!,
      pairEvaluations: s[4]!,
      compression: s[5]!,
      maximumSpeed: s[6]!,
      divergence: s[7]!,
      viscosityIterations: s[8]!,
    };
  }

  /** The rest volume of one accepted particle parcel in m³. */
  get particleVolume(): number {
    return this.ready().volume;
  }

  get mass(): number {
    const state = this.ready();
    return state.mass * numbers(state, state.stats)[0]!;
  }

  sample(index: number): DfsphReading {
    const state = this.ready();
    if (!Number.isSafeInteger(index) || index < 0 || index >= numbers(state, state.stats)[0]!)
      throw new RangeError('DFSPH point is outside the active rows. Choose a valid sample index.');
    const out = numbers(state, state.points);
    const at = index * DFSPH_PARTICLE_WORDS;
    return { position: xyz(out, at), velocity: xyz(out, at + 3), density: out[at + 6]!, mass: out[at + 7]! };
  }

  /** Copy tightly packed XYZ into staging storage for a renderer. */
  positions(out?: Float32Array): Float32Array {
    const state = this.ready();
    const count = numbers(state, state.stats)[0]!;
    const buffer = out ?? new Float32Array(count * 3);
    if (buffer.length < count * 3)
      throw new RangeError('DFSPH position buffer is too short. Provide three floats per active point.');
    const rows = numbers(state, state.points);
    for (let i = 0; i < count; i++) {
      const from = i * DFSPH_PARTICLE_WORDS;
      buffer[3 * i] = rows[from]!;
      buffer[3 * i + 1] = rows[from + 1]!;
      buffer[3 * i + 2] = rows[from + 2]!;
    }
    return buffer.subarray(0, count * 3);
  }

  private ready(): State {
    if (!this.state) throw new MargoError('state', 'DFSPH has no arena. Add it to a PhysicsWorld before using it.');
    return this.state;
  }
}
