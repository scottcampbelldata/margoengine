import { MargoError } from '@margoengine/math/errors';
import { gravityMagnitude } from '@margoengine/math/gravity';
import { pow } from '@margoengine/math/pinned';
import { type BedShape, BedChange, BED_CHANGE_FIELD, bedVertexAreas, bedVertexCount } from '../earth/bed.js';
import { SURFACE_WATER_FIELD, SURFACE_WATER_LAYOUT } from '../hydro/index.js';
import type { NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, DYNAMIC_BASE, isShared, MAX_MEMORY_PAGES, regionWords, STACK_BYTES } from '../world/memory.js';
import type {
  Cell,
  FieldDescriptor,
  FieldUse,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';

const BYTES = Float64Array.BYTES_PER_ELEMENT;
const LAYOUT = 1;
const U32 = Uint32Array.BYTES_PER_ELEMENT;
const WORK_WORDS = 2;
const JOB_HEADER_WORDS = 14;
const JOB_HEADER_BYTES = JOB_HEADER_WORDS * U32;
const JOB_BYTES = JOB_HEADER_BYTES + 3 * BYTES;
const MAX_THREADS = 64;
const STATE_PLANES = 4;
const LOAD = 0;
const CONCENTRATION = 1;
const BEDLOAD = 2;
const SHEAR = 3;
const SOLID_DENSITY = 2650;
const WATER_DENSITY = 1000;
const WATER_VISCOSITY = 1e-6;
const SOLID_POROSITY = 0.4;
const WONG_PARKER_SHIELDS = 0.0495;

type Scalars = number | ArrayLike<number>;

interface NativeKernel extends WebAssembly.Exports {
  sediment_step(
    state: number,
    available: number,
    bedDelta: number,
    area: number,
    flow: number,
    cohesion: number,
    scratch: number,
    budget: number,
    material: number,
    nx: number,
    nz: number,
    dx: number,
    dz: number,
    openSides: number,
    dt: number,
    receipt: number,
  ): number;
  sediment_thread_prepare(job: number): number;
  sediment_thread_phase(job: number, stage: number, part: number, parts: number): number;
  sediment_thread_settle_cells(job: number): number;
  sediment_thread_finish(job: number): number;
}

interface Builds {
  readonly plain: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
}

/** Load options and the incoming fields a sediment solver reads. */
export interface SedimentLoadOptions {
  /** ID and output field prefix. Defaults to 'sediment'. */
  readonly id?: string;
  /** Shallow-water field with triples of depth and horizontal water discharges. Default SURFACE_WATER_FIELD. */
  readonly waterField?: FieldDescriptor;
  /** Optional pressure field giving stabilisation by roots, one Pa value per water cell. */
  readonly rootCohesion?: FieldDescriptor;
  /** Native thread count including the caller. Defaults to one. Multiple threads need shared world memory. */
  readonly threads?: number;
  /** Cancels loading with the signal's reason. */
  readonly signal?: AbortSignal;
}

/** One erodible bed on the same grid as its shallow water. Distances and rates use SI. */
export interface SedimentParams {
  /** Actual TerrainBed grid. Field order is x-fast for its water cells and z-fast for the bed vertices. */
  readonly grid: BedShape;
  /** Median bed grain diameter, metres. Default 0.0003 (medium sand). */
  readonly grainDiameter?: number;
  /** Representative diameter of suspended particles, metres. Defaults to grainDiameter (uniform material). */
  readonly suspendedDiameter?: number;
  /** Grain density, kg/m³. Default 2650. */
  readonly grainDensity?: number;
  /** Ambient water density, kg/m³. Default 1000. */
  readonly waterDensity?: number;
  /** Kinematic viscosity, m²/s. Default 1e-6. */
  readonly viscosity?: number;
  /** Bed pore fraction, [0, 1). Default 0.4. */
  readonly porosity?: number;
  /** Manning roughness of the water, s/m^(1/3). Default 0.03. */
  readonly roughness?: number;
  /** Critical Shields number. Defaults to 0.0495 from Wong and Parker. */
  readonly criticalShields?: number;
  /** Override particle fall velocity in m/s. Defaults to the van Rijn settling law. */
  readonly settlingVelocity?: number;
  /** Erodible thickness in metres at the bed vertices. Default 0.1 m. At a rock floor use the actual bed clearance. */
  readonly mobileDepth?: Scalars;
  /** Initial depth-integrated suspended mass, kg/m², in each water cell. Default 0. */
  readonly suspendedMass?: Scalars;
  /** Additional bed and bank resistance in Pa, per water cell. Default 0. Root input adds to this resistance. */
  readonly cohesion?: Scalars;
  /** Bank erosion speed per unit near-bank speed difference. Default 0. Enable for an erodible channel. */
  readonly bankErodibility?: number;
  /** Sides that let sediment leave. Default all closed. Any incoming water here carries zero sediment. */
  readonly open?: Readonly<Partial<Record<'minX' | 'maxX' | 'minZ' | 'maxZ', boolean>>>;
}

/** Physical sediment loading in a water cell. */
export interface SedimentSample {
  /** Suspended solid mass per unit water volume, kg/m³. */
  readonly concentration: number;
  /** Suspended sediment mass in this cell, kg. */
  readonly suspended: number;
  /** Local bedload capacity per unit width, m²/s of solid. */
  readonly bedload: number;
  /** Bed shear from the current water depth and discharge, Pa. */
  readonly shearStress: number;
}

/** Solid mass stored, transported through boundaries, and redistributed at banks, in kg. */
export interface SedimentBudget {
  readonly bed: number;
  readonly suspended: number;
  readonly suspendedOut: number;
  readonly bedloadOut: number;
  /** Cumulative lateral transfer between bank and channel, already accounted in bed mass. */
  readonly bankTransfer: number;
}

/** Actual proposal work done by one native partition in the last successful tick. */
export interface SedimentWorkerWork {
  /** Number of water cells visited to calculate sediment exchange and transport capacities. */
  readonly cellProposals: number;
  /** Number of face fluxes evaluated, including zero fluxes on closed boundaries. */
  readonly faceProposals: number;
}

/** Total accepted proposal work, with counts per native partition. */
export interface SedimentWorkCounts extends SedimentWorkerWork {
  /** Number of partitions including the caller. */
  readonly threads: number;
  /** Actual per-partition proposal counts. */
  readonly workers: readonly SedimentWorkerWork[];
}

interface State {
  readonly host: SolverHost;
  readonly native: NativeKernel;
  readonly geometry: BedShape;
  readonly dx: number;
  readonly dz: number;
  readonly n: number;
  readonly openSides: number;
  readonly grains: number;
  readonly columns: Region;
  readonly available: Region;
  readonly candidateColumns: Region;
  readonly candidateAvailable: Region;
  readonly candidateDelta: Region;
  readonly candidateBudget: Region;
  readonly areas: Region;
  readonly change: BedChange;
  readonly materials: Region;
  readonly cohesion: Region;
  readonly combinedCohesion: Region;
  readonly scratch: Region;
  readonly copiedWater: Region;
  readonly budget: Region;
  readonly cell: Region;
  readonly receipts: Region;
  readonly work: Uint32Array;
  readonly job?: Region;
}

function check(label: string, value: number, min: number, max = Infinity, inclusive = true): number {
  if (!Number.isFinite(value) || value < min || value > max || (!inclusive && (value === min || value === max)))
    throw new MargoError(
      'state',
      `Invalid sediment ${label}; pass a finite value from ${min} to ${max} in the documented units.`,
    );
  return value;
}

function values(label: string, initial: Scalars, count: number): Float64Array {
  if (typeof initial === 'number') return new Float64Array(count).fill(check(label, initial, 0));
  if (!initial || initial.length !== count)
    throw new MargoError(
      'state',
      `Invalid sediment ${label} length; pass one number or ${count} values matching the grid.`,
    );
  return Float64Array.from(initial, (value) => check(label, value, 0));
}

/** Van Rijn's clear-water fall velocity for a representative grain diameter in metres. */
export function sedimentSettlingSpeed(
  diameter: number,
  grainDensity = SOLID_DENSITY,
  waterDensity = WATER_DENSITY,
  viscosity = WATER_VISCOSITY,
  gravity = 9.80665,
): number {
  const d = check('suspendedDiameter', diameter, 0, Infinity, false);
  const water = check('waterDensity', waterDensity, 0, Infinity, false);
  const grains = check('grainDensity', grainDensity, water, Infinity, false);
  const nu = check('viscosity', viscosity, 0, Infinity, false);
  const relativeGravity = check(
    'submerged gravity',
    (grains / water - 1) * check('gravity', gravity, 0, Infinity, false),
    0,
  );
  let speed: number;
  if (d <= 0.0001) {
    speed = (relativeGravity * d * d) / (18 * nu);
    if (!Number.isFinite(speed) || speed === 0) speed = ((relativeGravity * d) / nu) * (d / 18);
  } else if (d < 0.001) {
    const drag = (0.01 * relativeGravity * d * d * d) / (nu * nu);
    speed = (10 * nu * drag) / (d * (1 + Math.sqrt(1 + drag)));
    if (!Number.isFinite(speed))
      speed = (relativeGravity * d * d) / (10 * (nu + Math.sqrt(nu * nu + 0.01 * relativeGravity * d * d * d)));
  } else {
    speed = 1.1 * Math.sqrt(relativeGravity * d);
    if (!Number.isFinite(speed) || speed === 0) speed = 1.1 * Math.sqrt(relativeGravity) * Math.sqrt(d);
  }
  return check('settling speed', speed, 0);
}

function columnField(name: string, quantity: string, unit: string): FieldDescriptor {
  return { name, kind: 'uniformGrid', quantity, unit, centring: 'cell' };
}

async function readModule(asset: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  try {
    let module: WebAssembly.Module;
    if (asset.protocol === 'file:') {
      const node = 'node:fs/promises';
      asset.search = '';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ node);
      module = await WebAssembly.compile(await readFile(asset, { signal }));
    } else {
      const response = await fetch(asset, { signal });
      if (!response.ok)
        throw new MargoError(
          'failed',
          `Sediment kernel HTTP ${response.status}; serve the matching sediment Wasm file.`,
        );
      module = await WebAssembly.compile(await response.arrayBuffer());
    }
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(new MargoError('failed', 'Sediment Wasm could not load. Serve the matching SIMD assets.'), {
      cause,
    });
  }
}

function stackTop(host: SolverHost, name: string): number {
  const stack = host.allocate(name, STACK_BYTES + 8, 'u8', LAYOUT);
  return Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
}

function bindKernel(host: SolverHost, builds: Builds): NativeKernel {
  const module = isShared(host.memory) ? builds.shared : builds.plain;
  if (!module)
    throw new MargoError('unsupported', 'Shared sediment Wasm is unavailable on this host; choose plain world memory.');
  const top = stackTop(host, 'sediment-stack');
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw new MargoError('failed', 'Sediment Wasm does not export a stack pointer; rebuild both sediment assets.');
  pointer.value = top;
  return exports as NativeKernel;
}

function floats(state: State, region: Region): Float64Array {
  return regionWords(state.host.memory, region) as Float64Array;
}

function outputRegion(state: State, row: number, name: string): Region {
  const byteLength = state.n * BYTES;
  return { ...state.columns, name, byteLength, byteOffset: state.columns.byteOffset + row * byteLength };
}

/** Conservative suspended and bedload transport, Exner bed change and near-bank redistribution. */
export class SedimentTransport implements Solver<SedimentParams> {
  readonly concentrationField: FieldDescriptor;
  readonly bedloadField: FieldDescriptor;
  readonly shearField: FieldDescriptor;
  private readonly id: string;
  private readonly water: FieldDescriptor;
  private readonly roots?: FieldDescriptor;
  private state?: State;
  private pool?: NativePhasePool;
  private disposed = false;

  private constructor(
    private readonly builds: Builds,
    options: SedimentLoadOptions,
  ) {
    this.id = options.id ?? 'sediment';
    if (typeof this.id !== 'string' || !this.id || this.id.trim() !== this.id)
      throw new MargoError('state', 'Invalid sediment ID. Pass a nonempty ID without outer whitespace.');
    this.water = { ...(options.waterField ?? SURFACE_WATER_FIELD) };
    if (this.water.unit !== SURFACE_WATER_FIELD.unit)
      throw new MargoError('state', 'Invalid sediment water unit; bind the shallow-water depth and discharge field.');
    if (options.rootCohesion) {
      if (options.rootCohesion.unit !== 'Pa')
        throw new MargoError('state', 'Invalid sediment root-cohesion unit; supply stabilising pressure in Pa.');
      this.roots = { ...options.rootCohesion };
    }
    this.concentrationField = columnField(`${this.id}:concentration`, 'sedimentConcentration', 'kg/m^3');
    this.bedloadField = columnField(`${this.id}:bedload`, 'specificDischarge', 'm^2/s');
    this.shearField = columnField(`${this.id}:shear`, 'pressure', 'Pa');
  }

  /** Lazily loads the sediment assets for this runtime. Add the returned solver to a PhysicsWorld. */
  static async load(options: SedimentLoadOptions = {}): Promise<SedimentTransport> {
    if (options === null || typeof options !== 'object')
      throw new MargoError('state', 'Invalid sediment load options. Pass an options object or omit it.');
    const { signal, threads = 1 } = options;
    if (!Number.isSafeInteger(threads) || threads < 1 || threads > MAX_THREADS)
      throw new MargoError('state', `Choose a whole number of sediment threads from 1 to ${MAX_THREADS}.`);
    const [plain, shared] = await Promise.all([
      readModule(new URL(/* @vite-ignore */ './sediment-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? readModule(new URL(/* @vite-ignore */ './sediment-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    const solver = new SedimentTransport({ plain, shared }, options);
    if (threads > 1) {
      if (!shared)
        throw new MargoError('unsupported', 'Use a shared-memory runtime for sediment workers or use threads: 1.');
      const { createNativePhasePool } = await import('../native-phase-pool.js');
      solver.pool = await createNativePhasePool(threads, {
        subject: 'Sediment',
        phaseExport: 'sediment_thread_phase',
        phase: 'transport',
        signal,
      });
    }
    return solver;
  }

  /** Close the native workers after removing the solver from its world. */
  [Symbol.dispose](): void {
    this.disposed = true;
    this.pool?.close();
  }

  describe(): SolverDescription {
    const fields: FieldUse[] = [
      { field: this.water, access: 'read' },
      { field: BED_CHANGE_FIELD, access: 'accumulate' },
      { field: this.concentrationField, access: 'write' },
      { field: this.bedloadField, access: 'write' },
      { field: this.shearField, access: 'write' },
    ];
    if (this.roots) fields.push({ field: this.roots, access: 'read' });
    return { id: this.id, fields, rate: 0, stableRate: () => 0 };
  }

  init(host: SolverHost, params: SedimentParams): void {
    this.assertActive();
    if (this.pool && !isShared(host.memory))
      throw new MargoError('unsupported', 'Use worldMemory(true) for sediment threads or use threads: 1.');
    if (this.pool && this.state)
      throw new MargoError('attached', 'Sediment workers are already bound. Load a fresh solver for this world.');
    if (!params?.grid) throw new MargoError('state', 'Sediment needs a bed grid; pass the TerrainBed grid in metres.');
    let vertexCount: number;
    try {
      vertexCount = bedVertexCount(params.grid);
    } catch (cause) {
      throw Object.assign(
        new MargoError('state', 'Invalid sediment bed grid. Pass finite dimensions, whole cells and a finite centre.'),
        { cause },
      );
    }
    const geometry = { ...params.grid, centre: [...params.grid.centre] as [number, number] };
    const { columns: nx, rows: nz } = geometry;
    const dx = check('cell width', geometry.width / nx, Number.MIN_VALUE);
    const dz = check('cell depth', geometry.depth / nz, Number.MIN_VALUE);
    const cellArea = check('cell area', dx * dz, Number.MIN_VALUE);
    check('triangular cell area', cellArea / 6, Number.MIN_VALUE);
    const n = nx * nz;
    const nf = (nx + 1) * nz + nx * (nz + 1);
    const minimumBytes = (14 * n + 5 * vertexCount + 2 * nf) * BYTES;
    if (!Number.isSafeInteger(minimumBytes) || minimumBytes >= MAX_MEMORY_PAGES * 65536 - DYNAMIC_BASE)
      throw new MargoError('state', 'Sediment grid exceeds the wasm32 arena. Use fewer cells.');
    const areas = bedVertexAreas(geometry);
    const rho = check('waterDensity', params.waterDensity ?? WATER_DENSITY, 0, Infinity, false);
    const grains = check('grainDensity', params.grainDensity ?? SOLID_DENSITY, rho, Infinity, false);
    const viscosity = check('viscosity', params.viscosity ?? WATER_VISCOSITY, 0, Infinity, false);
    const diameter = check('grainDiameter', params.grainDiameter ?? 0.0003, 0, Infinity, false);
    const suspendedDiameter = check('suspendedDiameter', params.suspendedDiameter ?? diameter, 0, Infinity, false);
    const porosity = check('porosity', params.porosity ?? SOLID_POROSITY, 0, 1 - Number.EPSILON);
    const g = gravityMagnitude(host.gravity);
    const shearThreshold = check('criticalShields', params.criticalShields ?? WONG_PARKER_SHIELDS, 0, Infinity, false);
    const material = [
      rho,
      grains,
      diameter,
      porosity,
      g,
      check('roughness', params.roughness ?? 0.03, 0),
      check(
        'settlingVelocity',
        params.settlingVelocity ?? sedimentSettlingSpeed(suspendedDiameter, grains, rho, viscosity, g),
        0,
      ),
      diameter * pow(((grains / rho - 1) * g) / (viscosity * viscosity), 1 / 3),
      shearThreshold,
      check('bankErodibility', params.bankErodibility ?? 0, 0),
    ];
    check('dimensionless grain diameter', material[7]!, Number.MIN_VALUE);
    const solid = values('mobileDepth', params.mobileDepth ?? 0.1, areas.length);
    const initial = values('suspendedMass', params.suspendedMass ?? 0, n);
    const cohesion = values('cohesion', params.cohesion ?? 0, n);
    const openSides =
      (params.open?.minX ? 1 : 0) |
      (params.open?.maxX ? 2 : 0) |
      (params.open?.minZ ? 4 : 0) |
      (params.open?.maxZ ? 8 : 0);
    const allocate = (label: string, length: number) => host.allocate(label, length * BYTES, 'f64', LAYOUT);
    const state: State = {
      host,
      geometry,
      n,
      dx,
      dz,
      openSides,
      grains,
      native: bindKernel(host, this.builds),
      change: new BedChange(host, geometry, 'sediment-bed-change'),
      columns: allocate('sediment-columns', STATE_PLANES * n),
      available: allocate('sediment-mobile-bed', areas.length),
      candidateColumns: allocate('sediment-candidate-columns', STATE_PLANES * n),
      candidateAvailable: allocate('sediment-candidate-mobile-bed', areas.length),
      candidateDelta: allocate('sediment-candidate-bed-change', areas.length),
      candidateBudget: allocate('sediment-candidate-budget', 3),
      areas: allocate('sediment-bed-areas', areas.length),
      materials: allocate('sediment-material', material.length),
      cohesion: allocate('sediment-cohesion', n),
      combinedCohesion: allocate('sediment-input-cohesion', n),
      copiedWater: host.allocate('sediment-input-water', n * 3 * Float32Array.BYTES_PER_ELEMENT, 'f32', LAYOUT),
      scratch: allocate('sediment-scratch', 4 * n + 2 * nf),
      budget: allocate('sediment-budget', 3),
      cell: allocate('sediment-origin-cell', 3),
      receipts: host.allocate('sediment-work-receipts', WORK_WORDS * U32 * (this.pool?.count ?? 1), 'u32', LAYOUT),
      work: new Uint32Array(WORK_WORDS * (this.pool?.count ?? 1)),
    };
    const available = floats(state, state.available);
    const load = floats(state, state.columns);
    for (let edge = 0; edge < solid.length; edge++)
      available[edge] = check('mobile bed volume', solid[edge]! * areas[edge]! * (1 - porosity), 0);
    for (let i = 0; i < n; i++) {
      const mass = initial[i]!;
      const volume = (mass * dx * dz) / grains;
      load[LOAD * n + i] = check('suspended volume', Number.isFinite(volume) ? volume : (mass / grains) * cellArea, 0);
    }
    this.checkInventory(state, available, load);
    floats(state, state.areas).set(areas);
    floats(state, state.materials).set(material);
    floats(state, state.cohesion).set(cohesion);
    floats(state, state.cell).set(host.cell);
    this.state = { ...state, job: this.bindWorkers(state, this.pool) };
  }

  private bindWorkers(state: State, pool?: NativePhasePool): Region | undefined {
    if (!pool) return undefined;
    const { host, geometry } = state;
    const job = host.allocate('sediment-worker-job', JOB_BYTES, 'u32', LAYOUT);
    const control = host.allocate('sediment-worker-control', U32 * pool.controlWords, 'i32', LAYOUT);
    const stackTops = Array.from({ length: pool.count - 1 }, (_, part) =>
      stackTop(host, `sediment-worker-stack-${part + 1}`),
    );
    new Uint32Array(host.memory.buffer, job.byteOffset, JOB_HEADER_WORDS).set([
      state.candidateColumns.byteOffset,
      state.candidateAvailable.byteOffset,
      state.candidateDelta.byteOffset,
      state.areas.byteOffset,
      0,
      0,
      state.scratch.byteOffset,
      state.candidateBudget.byteOffset,
      state.materials.byteOffset,
      geometry.columns,
      geometry.rows,
      state.openSides,
      state.receipts.byteOffset,
    ]);
    new Float64Array(host.memory.buffer, job.byteOffset + JOB_HEADER_BYTES, 3).set([state.dx, state.dz]);
    pool.init({
      module: this.builds.shared!,
      memory: host.memory,
      job: job.byteOffset,
      control: control.byteOffset,
      stackTops,
    });
    return job;
  }

  importPorts(): void {
    // The scheduler provides the held water and vegetation mirrors through StepContext.
  }

  step(context: StepContext, dt: number): void {
    const state = this.requireState();
    const { host, geometry, n, dx, dz, native } = state;
    const port = context.inputs.get(this.water.name);
    if (!port) {
      state.change.clear();
      state.work.fill(0);
      return;
    }
    if (
      port.region.type !== 'f32' ||
      port.region.layout !== SURFACE_WATER_LAYOUT ||
      port.region.byteLength !== n * 3 * Float32Array.BYTES_PER_ELEMENT
    )
      throw new MargoError(
        'state',
        'Invalid sediment water port; supply layout-1 f32 depth, x and z discharge on the bed grid.',
      );
    if (!port.cell.every((coordinate, i) => coordinate === context.cell[i]))
      throw new MargoError(
        'state',
        'The sediment and water grids have different cells; set both solvers to the same world cell.',
      );
    const water = regionWords(host.memory, port.region) as Float32Array;
    for (let i = 0; i < n; i++) {
      const h = water[3 * i]!;
      if (h < 0 || !Number.isFinite(h) || !Number.isFinite(water[3 * i + 1]) || !Number.isFinite(water[3 * i + 2]))
        throw new MargoError(
          'state',
          'Invalid sediment water field; publish nonnegative depth and finite two-axis discharge.',
        );
    }
    let waterOffset = port.region.byteOffset;
    if (port.region.memory && port.region.memory !== host.memory) {
      (regionWords(host.memory, state.copiedWater) as Float32Array).set(water);
      waterOffset = state.copiedWater.byteOffset;
    }

    let cohesion = state.cohesion;
    const rootPort = this.roots && context.inputs.get(this.roots.name);
    if (rootPort) {
      if (!rootPort.cell.every((coordinate, i) => coordinate === context.cell[i]))
        throw new MargoError(
          'state',
          'The sediment and root grids have different cells; put both in the same world cell.',
        );
      const root = regionWords(host.memory, rootPort.region);
      if (
        root.length !== n ||
        rootPort.region.layout !== LAYOUT ||
        (rootPort.region.type !== 'f32' && rootPort.region.type !== 'f64')
      )
        throw new MargoError(
          'state',
          'Invalid sediment root port; publish one layout-1 f32 or f64 pressure per bed cell.',
        );
      const total = floats(state, state.combinedCohesion);
      const ground = floats(state, state.cohesion);
      for (let i = 0; i < n; i++)
        total[i] = check('root cohesion', ground[i]! + check('root pressure', root[i]!, 0), 0);
      cohesion = state.combinedCohesion;
    }

    if (!(dt > 0 && Number.isFinite(dt)))
      throw new MargoError('state', 'Invalid sediment interval. Advance the world by positive finite time.');
    const columns = floats(state, state.candidateColumns);
    const available = floats(state, state.candidateAvailable);
    const budget = floats(state, state.candidateBudget);
    const delta = floats(state, state.candidateDelta);
    columns.set(floats(state, state.columns));
    available.set(floats(state, state.available));
    budget.set(floats(state, state.budget));
    if (this.pool && state.job) {
      const ptr = state.job.byteOffset;
      const pool = this.pool;
      new Uint32Array(host.memory.buffer, ptr, JOB_HEADER_WORDS).set([waterOffset, cohesion.byteOffset], 4);
      new Float64Array(host.memory.buffer, ptr + JOB_HEADER_BYTES, 3)[2] = dt;
      this.checkNative(native.sediment_thread_prepare(ptr));
      this.checkNative(pool.phase(0, () => native.sediment_thread_phase(ptr, 0, 0, pool.count)));
      this.checkNative(native.sediment_thread_settle_cells(ptr));
      this.checkNative(pool.phase(1, () => native.sediment_thread_phase(ptr, 1, 0, pool.count)));
      this.checkNative(native.sediment_thread_finish(ptr));
    } else {
      this.checkNative(
        native.sediment_step(
          state.candidateColumns.byteOffset,
          state.candidateAvailable.byteOffset,
          state.candidateDelta.byteOffset,
          state.areas.byteOffset,
          waterOffset,
          cohesion.byteOffset,
          state.scratch.byteOffset,
          state.candidateBudget.byteOffset,
          state.materials.byteOffset,
          geometry.columns,
          geometry.rows,
          dx,
          dz,
          state.openSides,
          dt,
          state.receipts.byteOffset,
        ),
      );
    }
    this.checkInventory(state, available, columns);
    for (const volume of budget) check('exported mass', volume * state.grains, 0);
    for (const elevation of delta) {
      if (!Number.isFinite(Math.fround(elevation)))
        throw new MargoError(
          'state',
          'Sediment elevation change exceeds the TerrainBed range. Reduce the mobile depth or flow.',
        );
    }
    const receipts = new Uint32Array(host.memory.buffer, state.receipts.byteOffset, state.work.length);
    let cells = 0;
    let faces = 0;
    for (let at = 0; at < receipts.length; at += WORK_WORDS) {
      cells += receipts[at]!;
      faces += receipts[at + 1]!;
    }
    const nx = geometry.columns;
    const nz = geometry.rows;
    if (cells !== n || faces !== (nx + 1) * nz + nx * (nz + 1))
      throw new MargoError('failed', 'Sediment workers missed grid proposals. Rebuild the native assets.');
    state.work.set(receipts);
    floats(state, state.columns).set(columns);
    floats(state, state.available).set(available);
    floats(state, state.budget).set(budget);
    state.change.deltas.set(delta);
    floats(state, state.cell).set(context.cell);
  }

  private checkNative(status: number): void {
    if (status !== 0)
      throw new MargoError('state', 'Sediment flux exceeds numeric range. Reduce the flow, erodibility or time step.');
  }

  /** Native proposal counts from the last accepted tick, excluded from world snapshots. */
  workCounts(): SedimentWorkCounts {
    const { work } = this.requireState();
    const threads = work.length / WORK_WORDS;
    let cellProposals = 0;
    let faceProposals = 0;
    const workers = Array.from({ length: threads }, (_, part) => {
      const cells = work[WORK_WORDS * part]!;
      const faces = work[WORK_WORDS * part + 1]!;
      cellProposals += cells;
      faceProposals += faces;
      return { cellProposals: cells, faceProposals: faces };
    });
    return { threads, cellProposals, faceProposals, workers };
  }

  private checkInventory(state: State, available: Float64Array, columns: Float64Array): void {
    const { n, grains } = state;
    let bed = 0;
    let suspended = 0;
    for (const volume of available) bed += check('mobile bed volume', volume, 0);
    for (let i = 0; i < n; i++) {
      suspended += check('suspended volume', columns[LOAD * n + i]!, 0);
      const concentration = columns[CONCENTRATION * n + i]!;
      if (!Number.isFinite(Math.fround(concentration)) || concentration < 0)
        throw new MargoError(
          'state',
          'Sediment concentration exceeds float32. Reduce the solid load or grain density.',
        );
      check('bedload', columns[BEDLOAD * n + i]!, 0);
      check('bed shear', columns[SHEAR * n + i]!, 0);
    }
    check('bed mass', bed * grains, 0);
    check('suspended mass', suspended * grains, 0);
  }

  exportPorts(tick: number): readonly Port[] {
    const state = this.requireState();
    const [x, y, z] = floats(state, state.cell);
    const cell: Cell = [x!, y!, z!];
    return [
      state.change.port(tick, cell),
      {
        field: this.concentrationField.name,
        region: outputRegion(state, CONCENTRATION, this.concentrationField.name),
        tick,
        cell,
      },
      { field: this.bedloadField.name, region: outputRegion(state, BEDLOAD, this.bedloadField.name), tick, cell },
      { field: this.shearField.name, region: outputRegion(state, SHEAR, this.shearField.name), tick, cell },
    ];
  }

  stateRegions(): readonly Region[] {
    const s = this.requireState();
    return [s.columns, s.available, s.areas, s.change.state, s.materials, s.cohesion, s.budget, s.cell];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Read an X-column and Z-row of the sediment grid. */
  read(column: number, row: number): SedimentSample {
    const { geometry, n, grains } = this.requireState();
    if (
      !Number.isInteger(column) ||
      !Number.isInteger(row) ||
      column < 0 ||
      row < 0 ||
      column >= geometry.columns ||
      row >= geometry.rows
    )
      throw new MargoError('state', 'Invalid sediment cell; pass a column and row inside the bed grid.');
    const state = this.requireState();
    const i = column + row * geometry.columns;
    const words = floats(state, state.columns);
    return {
      concentration: words[CONCENTRATION * n + i]!,
      suspended: words[LOAD * n + i]! * grains,
      bedload: words[BEDLOAD * n + i]!,
      shearStress: words[SHEAR * n + i]!,
    };
  }

  /** Published concentration in kg/m³ at a world point in this grid's cell. Returns zero outside the grid. */
  concentrationAt(x: number, z: number): number {
    const state = this.requireState();
    const { geometry, dx, dz, n } = state;
    const column = Math.floor((x - geometry.centre[0] + geometry.width / 2) / dx);
    const row = Math.floor((z - geometry.centre[1] + geometry.depth / 2) / dz);
    if (!(column >= 0 && row >= 0 && column < geometry.columns && row < geometry.rows)) return 0;
    return floats(state, state.columns)[CONCENTRATION * n + column + row * geometry.columns]!;
  }

  /** Dimensions of the row-major concentration grid, [X columns, Z rows]. */
  get concentrationSize(): readonly [number, number] {
    const { geometry } = this.requireState();
    return [geometry.columns, geometry.rows];
  }

  /** Copies the current kg/m³ grid into a reusable Float32Array for water material input. */
  copyConcentrations(out: Float32Array): void {
    const state = this.requireState();
    if (!(out instanceof Float32Array) || out.length !== state.n)
      throw new MargoError(
        'state',
        `Invalid sediment output length; provide a Float32Array of ${state.n} grid values.`,
      );
    out.set(floats(state, state.columns).subarray(state.n, 2 * state.n));
  }

  /** Current tracked solid mass and its cumulative boundary losses. */
  get budget(): SedimentBudget {
    const state = this.requireState();
    const { n, grains } = state;
    const bed = floats(state, state.available).reduce((sum, value) => sum + value, 0);
    const load = floats(state, state.columns);
    let suspended = 0;
    for (let i = 0; i < n; i++) suspended += load[LOAD * n + i]!;
    const [suspendedOut, bedloadOut, bankTransfer] = floats(state, state.budget);
    return {
      bed: bed * grains,
      suspended: suspended * grains,
      suspendedOut: suspendedOut! * grains,
      bedloadOut: bedloadOut! * grains,
      bankTransfer: bankTransfer! * grains,
    };
  }

  private assertActive(): void {
    if (this.disposed)
      throw new MargoError('disposed', 'Sediment transport is disposed. Load a fresh solver for the world.');
  }

  private requireState(): State {
    this.assertActive();
    if (!this.state)
      throw new MargoError(
        'state',
        'Sediment has no terrain grid; add the solver to a PhysicsWorld before reading it.',
      );
    return this.state;
  }
}
