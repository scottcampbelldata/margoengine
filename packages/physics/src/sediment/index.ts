import { MargoError } from '@margoengine/math/errors';
import { gravityMagnitude } from '@margoengine/math/gravity';
import { pow } from '@margoengine/math/pinned';
import { type BedShape, BedChange, BED_CHANGE_FIELD, bedVertexAreas } from '../earth/bed.js';
import { SURFACE_WATER_FIELD, SURFACE_WATER_LAYOUT } from '../hydro/index.js';
import { canShareMemory, isShared, regionWords, STACK_BYTES } from '../world/memory.js';
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
  ): void;
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
  readonly areas: Region;
  readonly change: BedChange;
  readonly materials: Region;
  readonly cohesion: Region;
  readonly combinedCohesion: Region;
  readonly scratch: Region;
  readonly copiedWater: Region;
  readonly budget: Region;
  readonly cell: Region;
}

function check(label: string, value: number, min: number, max = Infinity, inclusive = true): number {
  if (!Number.isFinite(value) || value < min || value > max || (!inclusive && (value === min || value === max)))
    throw new RangeError(
      `Invalid sediment ${label}; pass a finite value from ${min} to ${max} in the documented units.`,
    );
  return value;
}

function values(label: string, initial: Scalars, count: number): Float64Array {
  if (typeof initial === 'number') return new Float64Array(count).fill(check(label, initial, 0));
  if (initial.length !== count)
    throw new RangeError(`Invalid sediment ${label} length; pass one number or ${count} values matching the grid.`);
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
  const relativeGravity = (grains / water - 1) * check('gravity', gravity, 0, Infinity, false);
  if (d <= 0.0001) return (relativeGravity * d * d) / (18 * nu);
  if (d < 0.001) {
    const drag = (0.01 * relativeGravity * d * d * d) / (nu * nu);
    return (10 * nu * drag) / (d * (1 + Math.sqrt(1 + drag)));
  }
  return 1.1 * Math.sqrt(relativeGravity * d);
}

function columnField(name: string, quantity: string, unit: string): FieldDescriptor {
  return { name, kind: 'uniformGrid', quantity, unit, centring: 'cell' };
}

async function readModule(asset: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (asset.protocol === 'file:') {
    const node = 'node:fs/promises';
    asset.search = '';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ node);
    return WebAssembly.compile(await readFile(asset, { signal }));
  }
  const response = await fetch(asset, { signal });
  if (!response.ok)
    throw new MargoError('failed', `Sediment kernel HTTP ${response.status}; serve the matching sediment Wasm file.`);
  return WebAssembly.compile(await response.arrayBuffer());
}

function bindKernel(host: SolverHost, builds: Builds): NativeKernel {
  const module = isShared(host.memory) ? builds.shared : builds.plain;
  if (!module)
    throw new MargoError('unsupported', 'Shared sediment Wasm is unavailable on this host; choose plain world memory.');
  const stack = host.allocate('sediment-stack', STACK_BYTES + 8, 'u8', LAYOUT);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw new MargoError('failed', 'Sediment Wasm does not export a stack pointer; rebuild both sediment assets.');
  pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
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

  private constructor(
    private readonly builds: Builds,
    options: SedimentLoadOptions,
  ) {
    this.id = options.id ?? 'sediment';
    this.water = { ...(options.waterField ?? SURFACE_WATER_FIELD) };
    if (this.water.unit !== SURFACE_WATER_FIELD.unit)
      throw new RangeError('Invalid sediment water unit; bind the shallow-water depth and discharge field.');
    if (options.rootCohesion) {
      if (options.rootCohesion.unit !== 'Pa')
        throw new RangeError('Invalid sediment root-cohesion unit; supply stabilising pressure in Pa.');
      this.roots = { ...options.rootCohesion };
    }
    this.concentrationField = columnField(`${this.id}:concentration`, 'sedimentConcentration', 'kg/m^3');
    this.bedloadField = columnField(`${this.id}:bedload`, 'specificDischarge', 'm^2/s');
    this.shearField = columnField(`${this.id}:shear`, 'pressure', 'Pa');
  }

  /** Lazily loads the sediment assets for this runtime. Add the returned solver to a PhysicsWorld. */
  static async load(options: SedimentLoadOptions = {}): Promise<SedimentTransport> {
    const { signal } = options;
    const [plain, shared] = await Promise.all([
      readModule(new URL(/* @vite-ignore */ './sediment-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? readModule(new URL(/* @vite-ignore */ './sediment-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    return new SedimentTransport({ plain, shared }, options);
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
    if (!params?.grid) throw new RangeError('Sediment needs a bed grid; pass the TerrainBed grid in metres.');
    const areas = bedVertexAreas(params.grid);
    const geometry = { ...params.grid, centre: [...params.grid.centre] as [number, number] };
    const { columns: nx, rows: nz } = geometry;
    const dx = geometry.width / nx;
    const dz = geometry.depth / nz;
    const n = nx * nz;
    const nf = (nx + 1) * nz + nx * (nz + 1);
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
      areas: allocate('sediment-bed-areas', areas.length),
      materials: allocate('sediment-material', material.length),
      cohesion: allocate('sediment-cohesion', n),
      combinedCohesion: allocate('sediment-input-cohesion', n),
      copiedWater: host.allocate('sediment-input-water', n * 3 * Float32Array.BYTES_PER_ELEMENT, 'f32', LAYOUT),
      scratch: allocate('sediment-scratch', 4 * n + 2 * nf),
      budget: allocate('sediment-budget', 3),
      cell: allocate('sediment-origin-cell', 3),
    };
    const available = floats(state, state.available);
    const load = floats(state, state.columns);
    for (let edge = 0; edge < solid.length; edge++) available[edge] = solid[edge]! * areas[edge]! * (1 - porosity);
    for (let i = 0; i < n; i++) load[LOAD * n + i] = (initial[i]! * dx * dz) / grains;
    floats(state, state.areas).set(areas);
    floats(state, state.materials).set(material);
    floats(state, state.cohesion).set(cohesion);
    this.state = state;
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
      return;
    }
    if (
      port.region.type !== 'f32' ||
      port.region.layout !== SURFACE_WATER_LAYOUT ||
      port.region.byteLength !== n * 3 * Float32Array.BYTES_PER_ELEMENT
    )
      throw new RangeError(
        'Invalid sediment water port; supply layout-1 f32 depth, x and z discharge on the bed grid.',
      );
    if (!port.cell.every((coordinate, i) => coordinate === context.cell[i]))
      throw new RangeError(
        'The sediment and water grids have different cells; set both solvers to the same world cell.',
      );
    const water = regionWords(host.memory, port.region) as Float32Array;
    for (let i = 0; i < n; i++) {
      const h = water[3 * i]!;
      if (h < 0 || !Number.isFinite(h) || !Number.isFinite(water[3 * i + 1]) || !Number.isFinite(water[3 * i + 2]))
        throw new RangeError('Invalid sediment water field; publish nonnegative depth and finite two-axis discharge.');
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
        throw new RangeError('The sediment and root grids have different cells; put both in the same world cell.');
      const root = regionWords(host.memory, rootPort.region);
      if (
        root.length !== n ||
        rootPort.region.layout !== LAYOUT ||
        (rootPort.region.type !== 'f32' && rootPort.region.type !== 'f64')
      )
        throw new RangeError('Invalid sediment root port; publish one layout-1 f32 or f64 pressure per bed cell.');
      const total = floats(state, state.combinedCohesion);
      const ground = floats(state, state.cohesion);
      for (let i = 0; i < n; i++)
        total[i] = check('root cohesion', ground[i]! + check('root pressure', root[i]!, 0), 0);
      cohesion = state.combinedCohesion;
    }

    native.sediment_step(
      state.columns.byteOffset,
      state.available.byteOffset,
      state.change.state.byteOffset,
      state.areas.byteOffset,
      waterOffset,
      cohesion.byteOffset,
      state.scratch.byteOffset,
      state.budget.byteOffset,
      state.materials.byteOffset,
      geometry.columns,
      geometry.rows,
      dx,
      dz,
      state.openSides,
      dt,
    );
    floats(state, state.cell).set(context.cell);
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
      throw new RangeError('Invalid sediment cell; pass a column and row inside the bed grid.');
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
      throw new RangeError(`Invalid sediment output length; provide a Float32Array of ${state.n} grid values.`);
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

  private requireState(): State {
    if (!this.state)
      throw new MargoError(
        'state',
        'Sediment has no terrain grid; add the solver to a PhysicsWorld before reading it.',
      );
    return this.state;
  }
}
