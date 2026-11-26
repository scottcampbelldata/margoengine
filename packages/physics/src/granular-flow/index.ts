import { MargoError } from '@margoengine/math/errors';
import { cos, sin } from '@margoengine/math/pinned';
import { BED_CHANGE_FIELD, BED_FIELD, BED_LAYOUT, BedChange, bedVertexCount, type BedShape } from '../earth/bed.js';
import { WAKE_SOURCE_LAYOUT, WAKE_SOURCE_WORDS } from '../sea/wake.js';
import { regionWords } from '../world/memory.js';
import type { FieldDescriptor, FieldUse, Port, Region, Solver, SolverHost, StepContext } from '../world/solver.js';
import {
  bindGranularFlowKernel,
  loadGranularFlowBuilds,
  type GranularFlowBuilds,
  type GranularFlowKernel,
} from './kernel.js';

/** Layout of the granular flow port. */
export const GRANULAR_FLOW_LAYOUT = 1;
/** Each row contains vertical depth, X and Z discharge, and bed elevation, in SI units. */
export const GRANULAR_FLOW_WORDS = 4;

export interface GranularFlowLoadOptions {
  /** Field namespace. Default 'granularFlow'. */
  readonly id?: string;
  /** Use a registered TerrainBed instead of the fixed bed option. Default false. */
  readonly liveTerrain?: boolean;
  /** Read the live bed and transfer arrested material into it. Default false. */
  readonly depositToTerrain?: boolean;
  /** Publish signed submerged-volume changes for SeaSource consumers. Default false. */
  readonly marineDisplacement?: boolean;
  /** Cancel loading of the optional native kernels. */
  readonly signal?: AbortSignal;
}

/** Scalar or one value per cell in row-major order (X varies fastest). */
type GridValues = number | ArrayLike<number>;

/** Pouliquen–Forterre start/stop fit. Angles are in degrees and thickness is in metres. */
export interface GranularRoughness {
  /** Limiting thick-layer stopping angle. */
  readonly thickStopAngle: number;
  /** Limiting thin-layer stopping angle. */
  readonly thinStopAngle: number;
  /** Limiting thick-layer starting angle. */
  readonly thickStartAngle: number;
  /** Stopping-curve transition length, metres. */
  readonly thickness: number;
  /** Froude slope of the steady uniform laboratory fit. */
  readonly beta: number;
  /** Stopping-curve form. Default 'rational' (2002). Use 'exponential' for the 1999 fits. */
  readonly curve?: 'rational' | 'exponential';
  /** Interpolation exponent below beta. Default 0.001. */
  readonly slowExponent?: number;
}

export interface GranularDeposition {
  /** Consolidated density in kilograms per cubic metre. Default the moving density. */
  readonly density?: number;
  /** Upper along-bed speed in metres per second for consolidation. Default 0. */
  readonly stopSpeed?: number;
}

export interface GranularDepositBudget {
  /** Total mass placed in TerrainBed, kilograms. */
  readonly mass: number;
  /** Horizontal momentum absorbed by the fixed bed, kilogram metres per second. */
  readonly impulse: readonly [number, number];
  /** Horizontal kinetic energy dissipated in consolidation, joules. */
  readonly horizontalKineticEnergy: number;
}

export interface GranularFlowOptions {
  /** Rectangular grid. When coupled, use the shape and world cell of TerrainBed. */
  readonly grid: BedShape;
  /** Fixed bed elevations in metres. Default 0. The live bed replaces this on the first world step. */
  readonly bed?: GridValues;
  /** Initial vertical layer depth in metres. Default 0. */
  readonly depth?: GridValues;
  /** Initial horizontal X and Z speeds in metres per second. Default [0, 0]. */
  readonly velocity?: readonly [GridValues, GridValues];
  /** Dry basal Coulomb coefficient. Default 0.35 without roughness. */
  readonly friction?: number;
  /** Depth and speed dependent basal stress, or the measured 0.5 mm glass-bead fit. Optional. */
  readonly roughness?: 'glass-beads' | GranularRoughness;
  /** Fraction of basal normal stress supported by prescribed pore pressure. Default 0 (dry). */
  readonly poreSupport?: number;
  /** Voellmy turbulent coefficient in metres per second squared. Default 2000 without roughness and Infinity with roughness. */
  readonly turbulence?: number;
  /** Constant bulk density in kilograms per cubic metre. Default 1600. */
  readonly density?: number;
  /** Arrested-layer transfer parameters when depositToTerrain is enabled. */
  readonly deposition?: GranularDeposition;
  /** Reference water surface in metres from the world cell, default 0. Requires marineDisplacement. */
  readonly seaLevel?: number;
}

export interface GranularMarineBudget {
  /** Current submerged occupancy of loose and consolidated material, cubic metres. */
  readonly occupiedVolume: number;
  /** Signed volume change since the first terrain sample, cubic metres. */
  readonly displacedVolume: number;
}

export interface GranularFlowSample {
  readonly depth: number;
  readonly discharge: readonly [number, number];
  readonly bedElevation: number;
  readonly surfaceElevation: number;
}

interface DepositState {
  readonly change: BedChange;
  readonly areas: Region;
  readonly deltas: Region;
  readonly params: Region;
  readonly trialBudget: Region;
}

interface MarineState {
  readonly history: Region;
  readonly next: Region;
  readonly source: Region;
  readonly sourceTrial: Region;
  readonly grid: Region;
  readonly budget: Region;
  readonly trialBudget: Region;
}

interface State {
  readonly host: SolverHost;
  readonly kernel: GranularFlowKernel;
  readonly grid: BedShape;
  readonly count: number;
  readonly dx: number;
  readonly dz: number;
  readonly gravity: number;
  readonly friction: number;
  readonly turbulence: number;
  readonly roughness?: Region;
  readonly grainLoad: number;
  readonly density: number;
  readonly state: Region;
  readonly working: Region;
  readonly trial: Region;
  readonly ledger: Region;
  readonly deposit?: DepositState;
  readonly marine?: MarineState;
  readonly regions: readonly Region[];
}

function finite(value: number, label: string, lower = -Infinity): number {
  if (!Number.isFinite(value) || value < lower)
    throw new RangeError(`Invalid granular ${label}. Use finite values in the documented SI range.`);
  return value;
}

const GLASS_BEADS: GranularRoughness = {
  thickStopAngle: 21,
  thinStopAngle: 30.7,
  thickStartAngle: 22.2,
  thickness: 0.00065,
  beta: 0.136,
};

function roughnessWords(profile: GranularRoughness): readonly number[] {
  const low = finite(profile.thickStopAngle, 'thick-layer stopping angle', 0);
  const high = finite(profile.thinStopAngle, 'thin-layer stopping angle', low);
  const start = finite(profile.thickStartAngle, 'thick-layer starting angle', low);
  if (high >= 90 || start >= 90)
    throw new RangeError('Invalid granular roughness angles. Use values below 90 degrees.');
  const tangent = (degrees: number) => {
    const radians = degrees * (Math.PI / 180);
    return sin(radians) / cos(radians);
  };
  const curve = profile.curve ?? 'rational';
  if (curve !== 'rational' && curve !== 'exponential')
    throw new RangeError('Invalid granular stopping curve. Choose rational or exponential.');
  return [
    tangent(low),
    tangent(high),
    tangent(start),
    finite(profile.thickness, 'roughness thickness', Number.MIN_VALUE),
    finite(profile.beta, 'roughness Froude coefficient', Number.MIN_VALUE),
    finite(profile.slowExponent ?? 0.001, 'low-speed roughness exponent', Number.MIN_VALUE),
    curve === 'exponential' ? 1 : 0,
  ];
}

function optionAt(values: GridValues, i: number, name: string, lower = -Infinity): number {
  return finite(typeof values === 'number' ? values : values[i]!, name, lower);
}

function words(state: State, region: Region): Float64Array {
  return new Float64Array(
    state.host.memory.buffer,
    region.byteOffset,
    region.byteLength / Float64Array.BYTES_PER_ELEMENT,
  );
}

/** Depth-averaged natural slides with mass-conservative transport and Coulomb–Voellmy resistance. */
export class GranularFlowSolver implements Solver<GranularFlowOptions> {
  /** Cell-centred granular state using GRANULAR_FLOW_LAYOUT. */
  readonly flowField: FieldDescriptor;
  /** Layout-1 SeaSource rows describing motion of the occupied volume. */
  readonly seaSourceField: FieldDescriptor;
  private readonly fields: readonly FieldUse[];
  private runtime?: State;

  private constructor(
    private readonly builds: GranularFlowBuilds,
    private readonly id: string,
    private readonly liveTerrain: boolean,
    private readonly depositToTerrain: boolean,
    private readonly marineDisplacement: boolean,
  ) {
    if (typeof id !== 'string' || !id.trim() || id !== id.trim())
      throw new RangeError('Invalid granular flow ID. Use a nonempty name without outer whitespace.');
    this.flowField = Object.freeze({
      name: `${id}.flow`,
      kind: 'uniformGrid',
      centring: 'cell',
      quantity: 'granularFlowState',
      unit: 'SI',
    });
    this.seaSourceField = Object.freeze({
      name: `${id}.seaSource`,
      kind: 'scalarSeries',
      centring: 'cell',
      quantity: 'seaSource',
      unit: 'SI',
    });
    this.fields = [
      { field: this.flowField, access: 'write' },
      ...(marineDisplacement ? [{ field: this.seaSourceField, access: 'write' as const }] : []),
      ...(liveTerrain ? [{ field: BED_FIELD, access: 'read' as const }] : []),
      ...(depositToTerrain ? [{ field: BED_CHANGE_FIELD, access: 'accumulate' as const }] : []),
    ];
  }

  /** Loads the optional SIMD kernels. */
  static async load({
    id = 'granularFlow',
    liveTerrain = false,
    depositToTerrain = false,
    marineDisplacement = false,
    signal,
  }: GranularFlowLoadOptions = {}): Promise<GranularFlowSolver> {
    return new GranularFlowSolver(
      await loadGranularFlowBuilds(signal),
      id,
      liveTerrain || depositToTerrain,
      depositToTerrain,
      marineDisplacement,
    );
  }

  describe() {
    return { id: this.id, fields: this.fields, rate: 0 as const, stableRate: () => 0 as const };
  }

  init(host: SolverHost, options: GranularFlowOptions): void {
    if (this.runtime)
      throw new MargoError('state', 'Granular flow is already attached. Load a new solver for another world.');
    bedVertexCount(options.grid);
    const grid: BedShape = { ...options.grid, centre: [options.grid.centre[0], options.grid.centre[1]] };
    const count = grid.columns * grid.rows;
    const dx = grid.width / grid.columns;
    const dz = grid.depth / grid.rows;
    finite(dx * dz, 'cell area', Number.MIN_VALUE);
    finite(dx + dz, 'cell size', Number.MIN_VALUE);
    const gravity = finite(-host.gravity[1], 'downward gravity', 0);
    if (options.seaLevel !== undefined && !this.marineDisplacement)
      throw new RangeError('Granular seaLevel requires a marine field. Enable marineDisplacement when loading.');
    const seaLevel = finite(options.seaLevel ?? 0, 'sea datum');
    const marineRadius = this.marineDisplacement
      ? finite(Math.sqrt((dx * dz) / Math.PI), 'marine footprint radius', Number.MIN_VALUE)
      : 0;
    if (this.marineDisplacement) {
      for (const [centre, span] of [
        [grid.centre[0], grid.width],
        [grid.centre[1], grid.depth],
      ] as const) {
        finite(centre - span / 2, 'marine near edge');
        finite(centre + span / 2, 'marine far edge');
      }
    }
    const poreSupport = finite(options.poreSupport ?? 0, 'pore pressure fraction', 0);
    if (poreSupport > 1) throw new RangeError('Invalid granular pore support. Set the fraction between zero and one.');
    if (options.roughness && options.friction !== undefined)
      throw new RangeError('Granular basal resistance has two models. Choose roughness or constant friction.');
    const profile =
      options.roughness === undefined
        ? undefined
        : roughnessWords(options.roughness === 'glass-beads' ? GLASS_BEADS : options.roughness);
    const friction = finite(options.friction ?? 0.35, 'friction', 0);
    const requestedTurbulence = options.turbulence ?? (profile ? Infinity : 2000);
    const turbulence =
      requestedTurbulence === Infinity ? Infinity : finite(requestedTurbulence, 'turbulence', Number.MIN_VALUE);
    const density = finite(options.density ?? 1600, 'bulk density', Number.MIN_VALUE);
    if (options.deposition && !this.depositToTerrain)
      throw new RangeError('Granular deposition options require a bed connection. Load with depositToTerrain enabled.');
    const depositDensity = finite(options.deposition?.density ?? density, 'deposit density', Number.MIN_VALUE);
    const stopSpeed = finite(options.deposition?.stopSpeed ?? 0, 'deposit arrest speed', 0);
    const depth = options.depth ?? 0;
    const bed = options.bed ?? 0;
    const [velocityX, velocityZ] = options.velocity ?? [0, 0];
    for (const input of [depth, bed, velocityX, velocityZ])
      if (typeof input !== 'number' && input.length !== count)
        throw new RangeError('Invalid granular grid values. Provide one value per cell or a scalar.');
    const bytes = count * GRANULAR_FLOW_WORDS * Float64Array.BYTES_PER_ELEMENT;
    const initial = new Float64Array(count * GRANULAR_FLOW_WORDS);
    for (let i = 0; i < count; i++) {
      const h = optionAt(depth, i, 'depth', 0);
      const vx = optionAt(velocityX, i, 'X velocity');
      const vz = optionAt(velocityZ, i, 'Z velocity');
      const b = optionAt(bed, i, 'bed elevation');
      finite(b + h, 'surface elevation');
      const at = GRANULAR_FLOW_WORDS * i;
      initial[at] = h;
      initial[at + 1] = finite(h * vx, 'X discharge');
      initial[at + 2] = finite(h * vz, 'Z discharge');
      initial[at + 3] = b;
    }

    const kernel = bindGranularFlowKernel(host, this.builds);
    const allocate = (name: string) => host.allocate(name, bytes, 'f64', GRANULAR_FLOW_LAYOUT);
    const state = allocate('granular-flow-state');
    const working = allocate('granular-flow-working');
    const trial = allocate('granular-flow-trial');
    const amount = Float64Array.BYTES_PER_ELEMENT;
    const ledger = host.allocate(
      'granular-flow-ledger',
      amount * (this.depositToTerrain ? 5 : 1),
      'f64',
      GRANULAR_FLOW_LAYOUT,
    );
    const deposit = this.depositToTerrain ? this.allocateDeposit(host, grid) : undefined;
    const roughness = profile
      ? host.allocate(
          'granular-roughness',
          profile.length * Float64Array.BYTES_PER_ELEMENT,
          'f64',
          GRANULAR_FLOW_LAYOUT,
        )
      : undefined;
    const marine = this.marineDisplacement ? this.allocateMarine(host, count) : undefined;
    const regions = [state, ledger];
    if (roughness) regions.push(roughness);
    if (deposit) regions.push(deposit.change.state);
    if (marine) regions.push(marine.history, marine.source, marine.budget);
    const s: State = {
      host,
      kernel,
      grid,
      count,
      dx,
      dz,
      gravity,
      friction,
      turbulence,
      roughness,
      grainLoad: 1 - poreSupport,
      density,
      state,
      working,
      trial,
      ledger,
      deposit,
      marine,
      regions,
    };
    words(s, state).set(initial);
    if (roughness && profile) words(s, roughness).set(profile);
    if (deposit) {
      words(s, deposit.areas).set(deposit.change.area);
      words(s, deposit.params).set([depositDensity, density, stopSpeed]);
    }
    if (marine)
      words(s, marine.grid).set([
        grid.centre[0] - grid.width / 2,
        grid.centre[1] - grid.depth / 2,
        dx,
        dz,
        seaLevel,
        marineRadius,
      ]);
    this.runtime = s;
  }

  private allocateDeposit(host: SolverHost, grid: BedShape): DepositState {
    const change = new BedChange(host, grid, 'granular-flow-bed-change');
    const amount = Float64Array.BYTES_PER_ELEMENT;
    return {
      change,
      areas: host.allocate('granular-flow-vertex-area', change.state.byteLength, 'f64', BED_LAYOUT),
      deltas: host.allocate('granular-flow-delta-trial', change.state.byteLength, 'f64', BED_LAYOUT),
      params: host.allocate('granular-flow-deposit-model', 3 * amount, 'f64', GRANULAR_FLOW_LAYOUT),
      trialBudget: host.allocate('granular-flow-deposit-trial', 4 * amount, 'f64', GRANULAR_FLOW_LAYOUT),
    };
  }

  private allocateMarine(host: SolverHost, count: number): MarineState {
    const allocate = (name: string, length: number, layout = GRANULAR_FLOW_LAYOUT) =>
      host.allocate(name, length * Float64Array.BYTES_PER_ELEMENT, 'f64', layout);
    return {
      history: allocate('granular-marine-history', 2 * count),
      next: allocate('granular-marine-next', 2 * count),
      source: allocate('granular-marine-source', WAKE_SOURCE_WORDS * count, WAKE_SOURCE_LAYOUT),
      sourceTrial: allocate('granular-marine-source-trial', WAKE_SOURCE_WORDS * count, WAKE_SOURCE_LAYOUT),
      grid: allocate('granular-marine-grid', 6),
      budget: allocate('granular-marine-budget', 3),
      trialBudget: allocate('granular-marine-budget-trial', 3),
    };
  }

  private attached(): State {
    if (!this.runtime) throw new MargoError('state', 'Granular flow is unattached. Add it to a PhysicsWorld first.');
    return this.runtime;
  }

  private readBed(context: StepContext, s: State, work: Float64Array): void {
    const port = context.inputs.get(BED_FIELD.name);
    const { columns, rows } = s.grid;
    if (
      !port ||
      port.region.layout !== BED_LAYOUT ||
      port.region.type !== 'f32' ||
      port.region.byteLength !== bedVertexCount(s.grid) * Float32Array.BYTES_PER_ELEMENT ||
      !port.cell.every((value, i) => value === context.cell[i])
    )
      throw new RangeError(
        'Invalid granular flow terrain. Use a registered TerrainBed with the same shape and world cell.',
      );
    const bed = regionWords(s.host.memory, port.region);
    const stride = rows + 1;
    for (let z = 0; z < rows; z++) {
      for (let x = 0; x < columns; x++) {
        const vertex = x * stride + z;
        // Each triangle contributes its vertices with one third of its area.
        const lower = bed[vertex]! / 6 + bed[vertex + 1]! / 3;
        const upper = bed[vertex + stride]! / 3 + bed[vertex + stride + 1]! / 6;
        work[GRANULAR_FLOW_WORDS * (x + z * columns) + 3] = finite(lower + upper, 'registered bed');
      }
    }
  }

  step(context: StepContext, dt: number): void {
    const s = this.attached();
    const work = words(s, s.working);
    work.set(words(s, s.state));
    if (this.liveTerrain) this.readBed(context, s, work);
    const substeps = s.kernel.granular_step(
      s.working.byteOffset,
      s.trial.byteOffset,
      s.grid.columns,
      s.grid.rows,
      dt,
      s.dx,
      s.dz,
      s.gravity,
      s.friction,
      s.turbulence,
      s.roughness?.byteOffset ?? 0,
      s.grainLoad,
    );
    if (substeps < 0)
      throw new RangeError(
        'Granular flow exceeded its finite-volume step range. Check layer depth, speed and spacing.',
      );
    if (s.deposit) this.prepareDeposit(s, s.deposit);
    const advanced = s.deposit ? s.trial : s.working;
    if (s.marine) this.prepareMarine(s, s.marine, advanced);
    if (s.deposit) {
      s.deposit.change.deltas.set(words(s, s.deposit.deltas));
      words(s, s.ledger).set(words(s, s.deposit.trialBudget), 1);
    }
    if (s.marine) {
      words(s, s.marine.source).set(words(s, s.marine.sourceTrial));
      words(s, s.marine.history).set(words(s, s.marine.next));
      words(s, s.marine.budget).set(words(s, s.marine.trialBudget));
    }
    words(s, s.state).set(words(s, advanced));
    words(s, s.ledger)[0] = substeps;
  }

  private prepareDeposit(s: State, deposit: DepositState): void {
    const trialBudget = words(s, deposit.trialBudget);
    trialBudget.set(words(s, s.ledger).subarray(1));
    const result = s.kernel.granular_deposit(
      s.working.byteOffset,
      s.trial.byteOffset,
      deposit.deltas.byteOffset,
      deposit.areas.byteOffset,
      deposit.trialBudget.byteOffset,
      deposit.params.byteOffset,
      s.grid.columns,
      s.grid.rows,
      s.dx,
      s.dz,
      s.gravity,
      s.friction,
      s.roughness?.byteOffset ?? 0,
      s.grainLoad,
    );
    if (result !== 0)
      throw new RangeError(
        'Granular deposition exceeded its mass or field range. Use finite physical depths and densities.',
      );
  }

  private prepareMarine(s: State, marine: MarineState, advanced: Region): void {
    const result = s.kernel.granular_sea_source(
      s.state.byteOffset,
      advanced.byteOffset,
      marine.history.byteOffset,
      marine.next.byteOffset,
      marine.sourceTrial.byteOffset,
      s.deposit?.deltas.byteOffset ?? 0,
      marine.grid.byteOffset,
      marine.budget.byteOffset,
      marine.trialBudget.byteOffset,
      s.grid.columns,
      s.grid.rows,
    );
    if (result !== 0)
      throw new RangeError(
        'Granular marine displacement exceeded its finite volume range. Check the sea datum, bed and grid spacing.',
      );
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const s = this.attached();
    const ports: Port[] = [{ field: this.flowField.name, region: s.state, tick, cell: [0, 0, 0] }];
    if (s.deposit) ports.push(s.deposit.change.port(tick));
    if (s.marine) ports.push({ field: this.seaSourceField.name, region: s.marine.source, tick, cell: [0, 0, 0] });
    return ports;
  }

  stateRegions(): readonly Region[] {
    return this.attached().regions;
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** State in one grid cell at the last completed world step. */
  sample(x: number, z: number): GranularFlowSample {
    const s = this.attached();
    if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || x >= s.grid.columns || z < 0 || z >= s.grid.rows)
      throw new RangeError('Granular sample is outside the grid. Use in-range integer X and Z indices.');
    const at = GRANULAR_FLOW_WORDS * (x + z * s.grid.columns);
    const w = words(s, s.state);
    return {
      depth: w[at]!,
      discharge: [w[at + 1]!, w[at + 2]!],
      bedElevation: w[at + 3]!,
      surfaceElevation: w[at]! + w[at + 3]!,
    };
  }

  /** Mass in kilograms represented by the current grid. */
  get mass(): number {
    const s = this.attached();
    const w = words(s, s.state);
    let sum = 0;
    for (let i = 0; i < s.count; i++) sum += w[GRANULAR_FLOW_WORDS * i]!;
    return sum * s.dx * s.dz * s.density;
  }

  /** Cumulative mass, horizontal impulse and kinetic energy transferred to the fixed bed. */
  get depositBudget(): GranularDepositBudget {
    const s = this.attached();
    const ledger = words(s, s.ledger);
    return { mass: ledger[1] ?? 0, impulse: [ledger[2] ?? 0, ledger[3] ?? 0], horizontalKineticEnergy: ledger[4] ?? 0 };
  }

  /** Submerged material volume and the signed change for water displacement. */
  get marineBudget(): GranularMarineBudget {
    const s = this.attached();
    if (!s.marine) return { occupiedVolume: 0, displacedVolume: 0 };
    const budget = words(s, s.marine.budget);
    return { occupiedVolume: budget[2]!, displacedVolume: budget[2]! - budget[1]! };
  }

  /** Number of positivity-limited subdivisions in the last world step. */
  get lastSubsteps(): number {
    const s = this.attached();
    return words(s, s.ledger)[0]!;
  }
}
