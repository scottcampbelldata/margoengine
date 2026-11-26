import { MargoError } from '@margoengine/math/errors';
import type {
  FieldDescriptor,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import { DYNAMIC_BASE, MAX_MEMORY_PAGES, STACK_BYTES } from '../world/memory.js';
import { bindGlacierKernel, type GlacierBuilds, type GlacierKernel, loadGlacierBuilds } from './kernel.js';

/** Glacier registry ports use x-fast layout-1 f64 cells. */
export const GLACIER_FIELD_LAYOUT = 1;

/** Whether a grid cell is grounded ice terrain, open water or the receiving side of a dry cliff. */
export type GlacierBoundary = 0 | 1 | 2;

/** Initial conditions and the constant forcing of a grounded, isothermal glacier. */
export interface GlacierOptions {
  /** Cell count in x. Must be positive. */
  readonly nx: number;
  /** Cell count in z. Must be positive. */
  readonly nz: number;
  /** Cell width in metres. */
  readonly dx: number;
  /** Cell length in metres. Defaults to dx. */
  readonly dz?: number;
  /** Cell-centred elevations in metres, x-fast. */
  readonly bed: ArrayLike<number>;
  /** Initial ice thickness in metres, x-fast. Defaults to zero. */
  readonly thickness?: ArrayLike<number>;
  /** Snow accumulation in metres of ice equivalent per simulated second. Defaults to zero. */
  readonly accumulation?: number | ArrayLike<number>;
  /** Potential melt in metres of ice equivalent per simulated second. Defaults to zero. */
  readonly melt?: number | ArrayLike<number>;
  /** Water column in an open surface crevasse, in metres. Defaults to zero. */
  readonly crevasseWater?: number | ArrayLike<number>;
  /** Cell classes: 0 grounded terrain, 1 open water, 2 dry cliff receiver. Defaults to grounded everywhere. */
  readonly boundary?: ArrayLike<GlacierBoundary>;
  /** Open-water elevation in metres. Defaults to zero. */
  readonly seaLevel?: number;
  /** Isothermal Glen n=3 softness in Pa⁻³ s⁻¹. Defaults to 2.4e-24 (temperate ice). */
  readonly softness?: number;
  /** Ice density in kg/m³. Defaults to 917. */
  readonly iceDensity?: number;
  /** Meltwater and open-water density in kg/m³. Defaults to 1000. */
  readonly waterDensity?: number;
  /** Simulated seconds per world second. Defaults to 1. Zero freezes the ice. */
  readonly timeScale?: number;
}

/** Controls for loading the optional glacier kernel. */
export interface GlacierLoadOptions {
  /** Solver ID and field prefix. Defaults to 'glacier'. */
  readonly id?: string;
  /** Cancels loading with the signal's reason. */
  readonly signal?: AbortSignal;
}

/** The ice state and latest output at one grid cell. */
export interface GlacierSample {
  /** Grounded ice thickness, in metres. */
  readonly thickness: number;
  /** Ice surface elevation, in metres. */
  readonly surface: number;
  /** Depth-averaged ice velocity, x then z, in m/s of simulated time. */
  readonly velocity: readonly [number, number];
  /** Crevasse depth immediately before any release in the last step, in metres. */
  readonly crevasseDepth: number;
  /** Meltwater delivered to this drainage outlet, in m³ per world second. */
  readonly meltwater: number;
  /** Ice volume detached at this water-facing cell in the last tick, in m³. */
  readonly calving: number;
  /** Ice volume detached at this dry cliff cell in the last tick, in m³. */
  readonly icefall: number;
}

/** Volumes for the ice mass balance, in m³ of ice equivalent. */
export interface GlacierBudget {
  /** Remaining grounded ice. */
  readonly ice: number;
  /** Cumulative snow accumulation. */
  readonly accumulation: number;
  /** Cumulative ice removed by surface melt. */
  readonly melted: number;
  /** Cumulative marine release. */
  readonly calved: number;
  /** Cumulative dry cliff release. */
  readonly fallen: number;
}

const STATE_COLUMNS = 7;
const INPUT_COLUMNS = 5;
const WORK_COLUMNS = 12;
const GRAPH_COLUMNS = 3;
const BUDGET_WORDS = 4;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const U32 = Uint32Array.BYTES_PER_ELEMENT;
const CENTRE = [0, 0, 0] as const;

interface Geometry {
  readonly nx: number;
  readonly nz: number;
  readonly dx: number;
  readonly dz: number;
  readonly cells: number;
}

interface GlacierState {
  readonly memory: WebAssembly.Memory;
  readonly kernel: GlacierKernel;
  readonly grid: Geometry;
  readonly config: Region;
  readonly parameters: Region;
  readonly values: Region;
  readonly next: Region;
  readonly work: Region;
  readonly graph: Region;
  readonly outputs: readonly Region[];
  readonly regions: readonly Region[];
}

function field(name: string, quantity: string, unit: string): FieldDescriptor {
  return Object.freeze({ name, kind: 'uniformGrid', quantity, unit, centring: 'cell' });
}

function words(memory: WebAssembly.Memory, region: Region): Float64Array {
  return new Float64Array(memory.buffer, region.byteOffset, region.byteLength / F64);
}

function finite(name: string, value: number, minimum = -Infinity): number {
  if (!Number.isFinite(value) || value < minimum)
    throw new RangeError(
      `Invalid glacier ${name}; use a finite value${minimum === -Infinity ? '' : ` >= ${minimum}`}.`,
    );
  return value;
}

function positive(name: string, value: number): number {
  if (!(Number.isFinite(value) && value > 0))
    throw new RangeError(`Invalid glacier ${name}; use a finite positive value in the documented unit.`);
  return value;
}

function geometry(options: GlacierOptions): Geometry {
  const { nx, nz } = options;
  const cells = nx * nz;
  if (!Number.isSafeInteger(nx) || nx <= 0 || !Number.isSafeInteger(nz) || nz <= 0 || !Number.isSafeInteger(cells))
    throw new RangeError('Invalid glacier grid; pass positive integer dimensions with a representable product.');
  const dx = positive('dx', options.dx);
  const dz = positive('dz', options.dz ?? dx);
  positive('cell area', dx * dz);
  positive('squared cell diagonal', dx * dx + dz * dz);
  if (dx * dx === 0 || dz * dz === 0)
    throw new RangeError('Glacier cells are smaller than representable; use practical metre-scale grid spacing.');
  const arenaBytes = (INPUT_COLUMNS + 2 * STATE_COLUMNS + WORK_COLUMNS) * F64 + GRAPH_COLUMNS * U32;
  if (cells * arenaBytes + DYNAMIC_BASE + STACK_BYTES + 2 * BUDGET_WORDS * F64 + 10 * F64 > MAX_MEMORY_PAGES * 65536)
    throw new RangeError('Glacier grid exceeds wasm32 memory; use fewer cells or a wider grid spacing.');
  return { nx, nz, dx, dz, cells };
}

function column(name: string, input: number | ArrayLike<number> | undefined, count: number, min: number): Float64Array {
  if (input === undefined || typeof input === 'number')
    return new Float64Array(count).fill(finite(name, input ?? 0, min));
  if (input?.length !== count) throw new RangeError(`Invalid glacier ${name}; supply one value per grid cell.`);
  return Float64Array.from(input, (value) => finite(name, value, min));
}

function portion(region: Region, name: string, offset: number, length: number): Region {
  return { ...region, name, byteOffset: region.byteOffset + offset * F64, byteLength: length * F64 };
}

function evolve(state: GlacierState, dt: number): void {
  const { memory, kernel, grid, config, values, next, parameters, work, graph } = state;
  const [, , dx, dz, gravity, softness, ice, water, sea, timeScale] = words(memory, config);
  const simulated = finite('simulated tick length', dt * timeScale!, 0);
  const scratch = words(memory, next);
  const destination = words(memory, values);
  scratch.set(destination);
  const result = kernel.glacier_step(
    next.byteOffset,
    parameters.byteOffset,
    work.byteOffset,
    graph.byteOffset,
    grid.nx,
    grid.nz,
    dx!,
    dz!,
    gravity!,
    softness!,
    ice!,
    water!,
    sea!,
    simulated,
    dt,
  );
  if (result === 1)
    throw new MargoError('failed', 'Glacier flow did not converge; reduce timeScale or increase grid spacing.');
  if (result !== 0)
    throw new RangeError('Glacier state exceeded numeric range; reduce forcing, topographic span, or timeScale.');
  destination.set(scratch);
}

/** Conservative shallow-ice flow, first-order calving and icefall, and meltwater drainage. */
export class GlacierSolver implements Solver<GlacierOptions> {
  readonly #id: string;
  readonly #builds: GlacierBuilds;
  #data: GlacierState | undefined;

  /** One f64 thickness per cell in metres. */
  readonly thicknessField: FieldDescriptor;
  /** One f64 pre-release crevasse depth per cell in metres. */
  readonly crevasseField: FieldDescriptor;
  /** One f64 liquid outlet discharge per cell in m³/s. */
  readonly meltwaterField: FieldDescriptor;
  /** One f64 marine released-ice volume per cell in m³ for each tick. */
  readonly calvingField: FieldDescriptor;
  /** One f64 dry icefall volume per cell in m³ for each tick. */
  readonly icefallField: FieldDescriptor;
  /** Two f64 component planes in m/s, all x cells then all z cells. */
  readonly velocityField: FieldDescriptor;

  #fields(): readonly FieldDescriptor[] {
    return [
      this.thicknessField,
      this.crevasseField,
      this.meltwaterField,
      this.calvingField,
      this.icefallField,
      this.velocityField,
    ];
  }

  private constructor(id: string, builds: GlacierBuilds) {
    this.#id = id;
    this.#builds = builds;
    this.thicknessField = field(id + '.thickness', 'height', 'm');
    this.crevasseField = field(id + '.crevasse', 'crevasseDepth', 'm');
    this.meltwaterField = field(id + '.meltwater', 'discharge', 'm^3/s');
    this.calvingField = field(id + '.calving', 'iceReleaseVolume', 'm^3');
    this.icefallField = field(id + '.icefall', 'iceReleaseVolume', 'm^3');
    this.velocityField = field(id + '.velocity', 'velocity', 'm/s');
  }

  /** Loads the plain and, where supported, shared-memory SIMD kernels. */
  static async load(options: GlacierLoadOptions = {}): Promise<GlacierSolver> {
    const id = options.id ?? 'glacier';
    if (typeof id !== 'string' || id.trim() === '' || id.trim() !== id)
      throw new RangeError('Invalid glacier solver ID; pass a nonempty identifier without outer whitespace.');
    return new GlacierSolver(id, await loadGlacierBuilds(options.signal));
  }

  /** Declares six field writes at the world base rate of 60 Hz. */
  describe(): SolverDescription {
    return {
      id: this.#id,
      fields: this.#fields().map((descriptor) => ({ field: descriptor, access: 'write' })),
      rate: 0,
      stableRate: () => 0,
    };
  }

  /** Initializes and copies the caller's grid into world-owned memory. */
  init(host: SolverHost, options: GlacierOptions): void {
    if (this.#data)
      throw new MargoError('attached', 'GlacierSolver already has a world; load a fresh solver to attach again.');
    if (!options?.bed) throw new RangeError('GlacierSolver needs bed elevations; pass a cell-centred bed grid.');
    const grid = geometry(options);
    const n = grid.cells;
    const material = {
      gravity: positive('downward gravity', -host.gravity[1]),
      softness: positive('Glen softness', options.softness ?? 2.4e-24),
      ice: positive('ice density', options.iceDensity ?? 917),
      water: positive('water density', options.waterDensity ?? 1000),
      sea: finite('sea level', options.seaLevel ?? 0),
      timeScale: finite('timeScale', options.timeScale ?? 1, 0),
    };
    if (!(material.water > material.ice))
      throw new RangeError(
        'Glacier ice cannot float in the given fluid; use a water density greater than the ice density.',
      );
    const stress = positive('ice weight density', material.gravity * material.ice);
    positive('Glen diffusion coefficient', (2 / 5) * material.softness * stress * stress * stress);
    const bed = column('bed elevations', options.bed, n, -Infinity);
    const snow = column('accumulation', options.accumulation, n, 0);
    const melt = column('melt', options.melt, n, 0);
    const water = column('crevasse water depth', options.crevasseWater, n, 0);
    const boundary = column('boundary', options.boundary, n, 0);
    const thickness = column('thickness', options.thickness, n, 0);
    for (let i = 0; i < n; i++) {
      const mode = boundary[i];
      if (mode !== 0 && mode !== 1 && mode !== 2)
        throw new RangeError(
          'Invalid glacier boundary class; use 0 for ground, 1 for open water, or 2 for a dry cliff receiver.',
        );
      if (mode !== 0 && (thickness[i] !== 0 || snow[i] !== 0))
        throw new RangeError(
          'Glacier receivers cannot carry grounded ice; set their thickness and accumulation to zero.',
        );
      if (mode === 1 && bed[i]! >= material.sea)
        throw new RangeError('Glacier open-water cells need a submerged bed; lower the bed or change the cell class.');
    }
    const kernel = bindGlacierKernel(host, this.#builds);
    const allocate = (name: string, count: number) =>
      host.allocate('glacier-' + name, count * F64, 'f64', GLACIER_FIELD_LAYOUT);
    const config = allocate(`config-${grid.nx}x${grid.nz}`, 10);
    const parameters = allocate('parameters', INPUT_COLUMNS * n);
    const values = allocate('values', STATE_COLUMNS * n + BUDGET_WORDS);
    const next = allocate('next', STATE_COLUMNS * n + BUDGET_WORDS);
    const work = allocate('work', WORK_COLUMNS * n);
    const graph = host.allocate('glacier-drainage', GRAPH_COLUMNS * n * U32, 'u32', GLACIER_FIELD_LAYOUT);
    const outputs = this.#fields().map((descriptor, i) => portion(values, descriptor.name, i * n, i === 5 ? 2 * n : n));
    const memory = host.memory;
    const { nx, nz, dx, dz } = grid;
    const { gravity, softness, ice, water: waterDensity, sea, timeScale } = material;
    words(memory, config).set([nx, nz, dx, dz, gravity, softness, ice, waterDensity, sea, timeScale]);
    const packed = words(memory, parameters);
    for (const [i, input] of [bed, snow, melt, water, boundary].entries()) packed.set(input, i * n);
    words(memory, values).set(thickness);
    const state = {
      memory,
      kernel,
      grid,
      config,
      parameters,
      values,
      next,
      work,
      graph,
      outputs,
      regions: [config, parameters, values],
    };
    evolve(state, 0);
    this.#data = state;
  }

  /** Advances one dyadic tick and publishes its drain and fracture releases. */
  step(_context: StepContext, dt: number): void {
    evolve(this.#state(), dt);
  }

  /** The supplied boundary and climate are local inputs. */
  importPorts(_tick: number): void {}

  /** Publishes the layout-1 cell arrays at the given tick. */
  exportPorts(tick: number): readonly Port[] {
    return this.#state().outputs.map((region) => ({ field: region.name, region, tick, cell: CENTRE }));
  }

  /** Region handles for repeatable snapshot and restore. */
  stateRegions(): readonly Region[] {
    return this.#state().regions;
  }

  /** No extra history is needed beyond the published state and cumulative budgets. */
  extraState(): readonly Region[] {
    return [];
  }

  /** Reads the state at a column and row, both zero-based. */
  sample(x: number, z: number): GlacierSample {
    const { memory, grid, parameters, values } = this.#state();
    const { nx, nz, cells: n } = grid;
    if (!Number.isInteger(x) || x < 0 || x >= nx || !Number.isInteger(z) || z < 0 || z >= nz)
      throw new RangeError('Glacier sample is outside the grid; use integer column and row indices inside the extent.');
    const i = z * nx + x;
    const data = words(memory, values);
    const thickness = data[i]!;
    return {
      thickness,
      surface: words(memory, parameters)[i]! + thickness,
      crevasseDepth: data[n + i]!,
      meltwater: data[2 * n + i]!,
      calving: data[3 * n + i]!,
      icefall: data[4 * n + i]!,
      velocity: [data[5 * n + i]!, data[6 * n + i]!],
    };
  }

  /** Reads cumulative volumes for the grounded-ice balance. */
  get budget(): GlacierBudget {
    const { memory, grid, config, values } = this.#state();
    const data = words(memory, values);
    const options = words(memory, config);
    const area = options[2]! * options[3]!;
    let thickness = 0;
    for (let i = 0; i < grid.cells; i++) thickness += data[i]!;
    const start = STATE_COLUMNS * grid.cells;
    return {
      ice: thickness * area,
      accumulation: data[start]!,
      melted: data[start + 1]!,
      calved: data[start + 2]!,
      fallen: data[start + 3]!,
    };
  }

  #state(): GlacierState {
    if (!this.#data)
      throw new MargoError('failed', 'GlacierSolver has no grid; add it to a PhysicsWorld with bed elevations first.');
    return this.#data;
  }
}
