import { MargoError } from '@margoengine/math/errors';
import { BED_FIELD, BED_LAYOUT, bedVertexCount, type BedShape } from '../earth/bed.js';
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
  /** Cancel loading of the optional native kernels. */
  readonly signal?: AbortSignal;
}

/** Scalar or one value per cell in row-major order (X varies fastest). */
type GridValues = number | ArrayLike<number>;

export interface GranularFlowOptions {
  /** Rectangular grid. When coupled, use the shape and world cell of TerrainBed. */
  readonly grid: BedShape;
  /** Fixed bed elevations in metres. Default 0. The live bed replaces this on the first world step. */
  readonly bed?: GridValues;
  /** Initial vertical layer depth in metres. Default 0. */
  readonly depth?: GridValues;
  /** Initial horizontal X and Z speeds in metres per second. Default [0, 0]. */
  readonly velocity?: readonly [GridValues, GridValues];
  /** Dry basal Coulomb coefficient. Default 0.35. */
  readonly friction?: number;
  /** Fraction of basal normal stress supported by prescribed pore pressure. Default 0 (dry). */
  readonly poreSupport?: number;
  /** Voellmy turbulent coefficient in metres per second squared. Default 2000. Use Infinity for Coulomb alone. */
  readonly turbulence?: number;
  /** Constant bulk density in kilograms per cubic metre. Default 1600. */
  readonly density?: number;
}

export interface GranularFlowSample {
  readonly depth: number;
  readonly discharge: readonly [number, number];
  readonly bedElevation: number;
  readonly surfaceElevation: number;
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
  readonly density: number;
  readonly state: Region;
  readonly working: Region;
  readonly trial: Region;
  readonly ledger: Region;
  readonly regions: readonly Region[];
}

function finite(value: number, label: string, lower = -Infinity): number {
  if (!Number.isFinite(value) || value < lower)
    throw new RangeError(`Invalid granular ${label}. Use finite values in the documented SI range.`);
  return value;
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
  private readonly fields: readonly FieldUse[];
  private runtime?: State;

  private constructor(
    private readonly builds: GranularFlowBuilds,
    private readonly id: string,
    private readonly liveTerrain: boolean,
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
    this.fields = [
      { field: this.flowField, access: 'write' },
      ...(liveTerrain ? [{ field: BED_FIELD, access: 'read' as const }] : []),
    ];
  }

  /** Loads the optional SIMD kernels. */
  static async load({
    id = 'granularFlow',
    liveTerrain = false,
    signal,
  }: GranularFlowLoadOptions = {}): Promise<GranularFlowSolver> {
    return new GranularFlowSolver(await loadGranularFlowBuilds(signal), id, liveTerrain);
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
    const poreSupport = finite(options.poreSupport ?? 0, 'pore pressure fraction', 0);
    if (poreSupport > 1) throw new RangeError('Invalid granular pore support. Set the fraction between zero and one.');
    const friction = finite(options.friction ?? 0.35, 'friction', 0) * (1 - poreSupport);
    const turbulence =
      options.turbulence === Infinity ? Infinity : finite(options.turbulence ?? 2000, 'turbulence', Number.MIN_VALUE);
    const density = finite(options.density ?? 1600, 'bulk density', Number.MIN_VALUE);
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
    const ledger = host.allocate('granular-flow-ledger', Float64Array.BYTES_PER_ELEMENT, 'f64', GRANULAR_FLOW_LAYOUT);
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
      density,
      state,
      working,
      trial,
      ledger,
      regions: [state, ledger],
    };
    words(s, state).set(initial);
    this.runtime = s;
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
    );
    if (substeps < 0)
      throw new RangeError(
        'Granular flow exceeded its finite-volume step range. Check layer depth, speed and spacing.',
      );
    words(s, s.state).set(work);
    words(s, s.ledger)[0] = substeps;
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const s = this.attached();
    return [{ field: this.flowField.name, region: s.state, tick, cell: [0, 0, 0] }];
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

  /** Number of positivity-limited subdivisions in the last world step. */
  get lastSubsteps(): number {
    const s = this.attached();
    return words(s, s.ledger)[0]!;
  }
}
