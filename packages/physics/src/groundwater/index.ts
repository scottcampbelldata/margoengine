import { MargoError } from '@margoengine/math/errors';
import { type BedShape, BED_FIELD, BED_LAYOUT, bedVertexCount } from '../earth/bed.js';
import type { ShallowRunoffInput } from '../hydro/index.js';
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

const LAYOUT = 1;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const THICKNESS = 0;
const HEAD = 1;
const SPRINGS = 3;
const SEEPAGE = 4;
const SIDES = ['minX', 'maxX', 'minZ', 'maxZ'] as const;

type Scalars = number | ArrayLike<number>;

/** Field bindings and lifetime of the native groundwater loader. */
export interface GroundwaterLoadOptions {
  /** Solver ID and prefix for its output fields. Defaults to 'groundwater'. */
  readonly id?: string;
  /** Layout-1 recharge in m/s on the same cell grid, for example RainfallRunoff.rechargeField. */
  readonly rechargeField?: FieldDescriptor;
  /** Follow the canonical TerrainBed field for the current seepage surface. Defaults to false. */
  readonly followTerrain?: boolean;
  /** Cancels loading with the signal's reason. */
  readonly signal?: AbortSignal;
}

/** Grid and porous properties for a single water-table aquifer. Cell arrays are x-fast. */
export interface GroundwaterParams {
  /** Rectangle and cell counts in metres. Match the recharge and shallow-water grids. */
  readonly grid: BedShape;
  /** Aquifer bottom elevations in metres. Default -10. */
  readonly bottom?: Scalars;
  /** Ground surface elevations in metres. Default 0. */
  readonly surface?: Scalars;
  /** Initial absolute water-table elevation in metres. Default 80% of the depth from bottom to surface. */
  readonly initialHead?: Scalars;
  /** Downward source in m/s, added to any field-driven recharge. Default zero. */
  readonly recharge?: Scalars;
  /** Horizontal saturated conductivity in m/s. Default 0.0001. */
  readonly conductivity?: Scalars;
  /** Override conductivity along world X, in m/s. */
  readonly conductivityX?: Scalars;
  /** Override conductivity along world Z, in m/s. */
  readonly conductivityZ?: Scalars;
  /** Drainable water fraction in (0, 1]. Default 0.2. */
  readonly specificYield?: Scalars;
  /** Elevation at which a spring starts flowing, in metres. Defaults to the initial ground surface. */
  readonly springElevation?: Scalars;
  /** Spring conductance in m²/s, multiplying positive head above its elevation. Default zero. */
  readonly springConductance?: Scalars;
  /** Constant hydraulic heads on open sides in metres. Omitted sides are impermeable. */
  readonly sideHeads?: Readonly<Partial<Record<(typeof SIDES)[number], number>>>;
  /** Underground seconds represented by one world second. Default 1. */
  readonly secondsPerSecond?: number;
  /** Relative infinity-norm residual of the linear volume solve. Default 1e-12. */
  readonly relativeResidual?: number;
}

/** Current water table and discharge of a groundwater cell. */
export interface GroundwaterSample {
  /** Water table elevation, m. */
  readonly head: number;
  /** Saturated thickness above the aquifer floor, m. */
  readonly thickness: number;
  /** Drainable water stored in this cell, m³. */
  readonly storage: number;
  /** Discharge through configured springs, m³/world s. */
  readonly spring: number;
  /** Seepage released at the terrain surface, m³/world s. */
  readonly seepage: number;
}

/** Current storage and cumulative water volumes in m³. */
export interface GroundwaterBudget {
  readonly storage: number;
  readonly recharge: number;
  readonly boundaryIn: number;
  readonly boundaryOut: number;
  readonly spring: number;
  readonly seepage: number;
}

interface GroundwaterKernel extends WebAssembly.Exports {
  groundwater_step(
    controls: number,
    forcing: number,
    sides: number,
    state: number,
    budget: number,
    scratch: number,
    nx: number,
    nz: number,
    dx: number,
    dz: number,
    dt: number,
    worldDt: number,
    tolerance: number,
  ): number;
}

interface State {
  readonly host: SolverHost;
  readonly kernel: GroundwaterKernel;
  readonly grid: BedShape;
  readonly n: number;
  readonly area: number;
  readonly dx: number;
  readonly dz: number;
  readonly timeScale: number;
  readonly tolerance: number;
  readonly forcing: Region;
  readonly defaults: Region;
  readonly controls: Region;
  readonly sides: Region;
  readonly columns: Region;
  readonly budget: Region;
  readonly scratch: Region;
  readonly cell: Region;
}

function validate(name: string, value: number, min = -Infinity, max = Infinity): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new RangeError(
      `Invalid groundwater ${name}; supply a finite value from ${min} to ${max} in its stated units.`,
    );
  return value;
}

function fill(target: Float64Array, value: Scalars, name: string, min = -Infinity, max = Infinity): void {
  if (typeof value === 'number') {
    target.fill(validate(name, value, min, max));
    return;
  }
  if (value.length !== target.length)
    throw new RangeError(`Invalid groundwater ${name} length; pass one value or ${target.length} x-fast cell samples.`);
  for (let i = 0; i < target.length; i++) target[i] = validate(name, value[i]!, min, max);
}

function field(name: string, quantity: string, unit: string): FieldDescriptor {
  return { name, kind: 'uniformGrid', quantity, unit, centring: 'cell' };
}

function floats(host: SolverHost, region: Region): Float64Array {
  return regionWords(host.memory, region) as Float64Array;
}

async function readModule(file: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (file.protocol === 'file:') {
    const moduleName = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ moduleName);
    file.search = '';
    return WebAssembly.compile(await readFile(file, { signal }));
  }
  const response = await fetch(file, { signal });
  if (!response.ok)
    throw new MargoError(
      'failed',
      `Groundwater kernel HTTP ${response.status}; serve the matching groundwater Wasm asset.`,
    );
  return WebAssembly.compile(await response.arrayBuffer());
}

function sameCell(a: Cell, b: Cell): boolean {
  return a.every((coordinate, i) => coordinate === b[i]);
}

/** Conservative unconfined Darcy flow with aquifer storage, springs, and surface seepage. */
export class GroundwaterSolver implements Solver<GroundwaterParams> {
  /** Absolute water-table elevation in metres, layout-1 f64 per cell. */
  readonly headField: FieldDescriptor;
  /** Combined spring and seepage volume flow, m³/world s, layout-1 f64 per cell. */
  readonly outletField: FieldDescriptor;
  /** Spring discharge in m³/world s, layout-1 f64 per cell. */
  readonly springField: FieldDescriptor;
  /** Surface seepage in m³/world s, layout-1 f64 per cell. */
  readonly seepageField: FieldDescriptor;
  private readonly id: string;
  private readonly recharge?: FieldDescriptor;
  private readonly followTerrain: boolean;
  private state?: State;

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    options: GroundwaterLoadOptions,
  ) {
    this.id = options.id ?? 'groundwater';
    if (options.rechargeField) {
      if (options.rechargeField.unit !== 'm/s' || options.rechargeField.centring !== 'cell')
        throw new RangeError('Invalid groundwater recharge field; bind a cell-centred field in m/s.');
      this.recharge = { ...options.rechargeField };
    }
    this.followTerrain = options.followTerrain ?? false;
    this.headField = field(`${this.id}:head`, 'groundwaterHead', 'm');
    this.outletField = field(`${this.id}:outlets`, 'volumeFlowRate', 'm^3/s');
    this.springField = field(`${this.id}:springs`, 'volumeFlowRate', 'm^3/s');
    this.seepageField = field(`${this.id}:seepage`, 'volumeFlowRate', 'm^3/s');
  }

  /** Loads the optional native kernel. Add the resulting solver to a PhysicsWorld. */
  static async load(options: GroundwaterLoadOptions = {}): Promise<GroundwaterSolver> {
    const { signal } = options;
    const [plain, shared] = await Promise.all([
      readModule(new URL(/* @vite-ignore */ './groundwater-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? readModule(new URL(/* @vite-ignore */ './groundwater-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    return new GroundwaterSolver(plain, shared, options);
  }

  describe(): SolverDescription {
    const fields: FieldUse[] = [
      { field: this.headField, access: 'write' },
      { field: this.outletField, access: 'write' },
      { field: this.springField, access: 'write' },
      { field: this.seepageField, access: 'write' },
    ];
    if (this.recharge) fields.push({ field: this.recharge, access: 'read' });
    if (this.followTerrain) fields.push({ field: BED_FIELD, access: 'read' });
    return { id: this.id, fields, rate: 0, stableRate: () => 0 };
  }

  init(host: SolverHost, params: GroundwaterParams): void {
    if (!params?.grid) throw new RangeError('Groundwater needs a grid; pass a TerrainBed rectangle in metres.');
    bedVertexCount(params.grid);
    const grid = { ...params.grid, centre: [params.grid.centre[0], params.grid.centre[1]] as const };
    const n = grid.columns * grid.rows;
    const dx = grid.width / grid.columns;
    const dz = grid.depth / grid.rows;
    const area = validate('cell area', dx * dz, Number.MIN_VALUE);
    const timeScale = validate('time scale', params.secondsPerSecond ?? 1, Number.MIN_VALUE);
    const tolerance = validate('relative residual', params.relativeResidual ?? 1e-12, Number.EPSILON, 1);
    // A non-isolated browser can hand out shared Wasm memory without exposing the JS constructor.
    const sharedMemory =
      isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]';
    const module = sharedMemory ? this.shared : this.plain;
    if (!module)
      throw new MargoError('unsupported', 'Shared groundwater Wasm is unavailable; choose plain world memory.');
    const stack = host.allocate('groundwater-stack', STACK_BYTES + 8, 'u8', LAYOUT);
    const kernel = new WebAssembly.Instance(module, { env: { memory: host.memory } }).exports as GroundwaterKernel;
    const pointer = kernel.__stack_pointer;
    const end = kernel.__data_end;
    if (!(pointer instanceof WebAssembly.Global) || !(end instanceof WebAssembly.Global) || end.value !== 0)
      throw new MargoError('failed', 'Invalid groundwater kernel layout; rebuild the slot-free groundwater assets.');
    pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;

    const allocate = (name: string, count: number) => host.allocate('groundwater-' + name, count * F64, 'f64', LAYOUT);
    const state: State = {
      host,
      kernel,
      grid,
      n,
      dx,
      dz,
      area,
      timeScale,
      tolerance,
      forcing: allocate('forcing', 2 * n),
      defaults: allocate('baseline-forcing', 2 * n),
      controls: allocate('aquifer-properties', 6 * n),
      sides: allocate('fixed-side-heads', SIDES.length),
      columns: allocate('columns', 5 * n),
      budget: allocate('budget', 5),
      scratch: allocate('linear-solve', 12 * n),
      cell: allocate('origin', 3),
    };
    const config = floats(host, state.controls);
    const baseline = floats(host, state.defaults);
    const bottom = config.subarray(0, n);
    const surface = baseline.subarray(0, n);
    const initial = floats(host, state.columns);
    const head = initial.subarray(n, 2 * n);
    const k = params.conductivity ?? 1e-4;
    fill(bottom, params.bottom ?? -10, 'bottom elevation');
    fill(surface, params.surface ?? 0, 'ground elevation');
    fill(baseline.subarray(n), params.recharge ?? 0, 'recharge', 0);
    fill(config.subarray(n, 2 * n), params.conductivityX ?? k, 'X conductivity', 0);
    fill(config.subarray(2 * n, 3 * n), params.conductivityZ ?? k, 'Z conductivity', 0);
    fill(config.subarray(3 * n, 4 * n), params.specificYield ?? 0.2, 'specific yield', Number.MIN_VALUE, 1);
    fill(config.subarray(4 * n, 5 * n), params.springElevation ?? surface, 'spring elevation');
    fill(config.subarray(5 * n), params.springConductance ?? 0, 'spring conductance', 0);
    if (params.initialHead !== undefined) fill(head, params.initialHead, 'initial head');
    for (let i = 0; i < n; i++) {
      const low = bottom[i]!;
      const high = surface[i]!;
      const depth = validate('aquifer thickness', high - low, 0);
      const storage = config[3 * n + i]! * area;
      validate('cell storage coefficient', storage, Number.MIN_VALUE);
      validate('saturated storage', storage * depth, 0);
      initial[i] = params.initialHead === undefined ? 0.8 * depth : validate('initial head', head[i]!, low, high) - low;
      head[i] = low + initial[i]!;
    }
    const sides = floats(host, state.sides);
    sides.fill(NaN);
    for (const [index, side] of SIDES.entries()) {
      const fixed = params.sideHeads?.[side];
      if (fixed !== undefined) sides[index] = validate(`${side} fixed head`, fixed);
    }
    this.state = state;
  }

  importPorts(): void {
    // Recharge and the current bed enter through StepContext's held registry ports.
  }

  step(context: StepContext, dt: number): void {
    const s = this.requireState();
    const values = floats(s.host, s.forcing);
    values.set(floats(s.host, s.defaults));
    const rain = this.recharge && context.inputs.get(this.recharge.name);
    if (rain) this.readRecharge(s, rain, context.cell, values.subarray(s.n));
    const bed = this.followTerrain && context.inputs.get(BED_FIELD.name);
    if (bed) this.readBed(s, bed, context.cell, values.subarray(0, s.n));
    const code = s.kernel.groundwater_step(
      s.controls.byteOffset,
      s.forcing.byteOffset,
      s.sides.byteOffset,
      s.columns.byteOffset,
      s.budget.byteOffset,
      s.scratch.byteOffset,
      s.grid.columns,
      s.grid.rows,
      s.dx,
      s.dz,
      validate('scaled timestep', dt * s.timeScale, Number.MIN_VALUE),
      dt,
      s.tolerance,
    );
    if (code !== 0)
      throw new MargoError(
        'failed',
        'The groundwater volume solve did not converge; reduce the time scale or conductivity contrast.',
      );
    floats(s.host, s.cell).set(context.cell);
  }

  private readRecharge(s: State, port: Port, cell: Cell, output: Float64Array): void {
    const r = port.region;
    if (
      !sameCell(port.cell, cell) ||
      r.layout !== LAYOUT ||
      (r.type !== 'f32' && r.type !== 'f64') ||
      r.byteLength !== s.n * (r.type === 'f32' ? 4 : F64)
    )
      throw new RangeError(
        'Invalid groundwater recharge port; publish one layout-1 scalar per aquifer cell in the same world cell.',
      );
    const words = regionWords(s.host.memory, r);
    for (let i = 0; i < s.n; i++) {
      output[i] = validate('total recharge', output[i]! + validate('field recharge', words[i]!, 0), 0);
    }
  }

  private readBed(s: State, port: Port, cell: Cell, output: Float64Array): void {
    const r = port.region;
    const { columns, rows } = s.grid;
    const stride = rows + 1;
    if (
      !sameCell(port.cell, cell) ||
      r.type !== 'f32' ||
      r.layout !== BED_LAYOUT ||
      r.byteLength !== 4 * (columns + 1) * stride
    )
      throw new RangeError('Invalid groundwater bed port; place a matching TerrainBed in the same world cell.');
    const words = regionWords(s.host.memory, r);
    for (let z = 0; z < rows; z++) {
      for (let x = 0; x < columns; x++) {
        // The terrain's shared triangle edge crosses the centre of the cell.
        const vertex = z + stride * x;
        output[z * columns + x] = validate(
          'terrain elevation',
          0.5 * words[vertex + 1]! + 0.5 * words[vertex + stride]!,
        );
      }
    }
  }

  exportPorts(tick: number): readonly Port[] {
    const s = this.requireState();
    const [x, y, z] = floats(s.host, s.cell);
    const cell: Cell = [x!, y!, z!];
    const byteLength = s.n * F64;
    const fields = [this.headField, this.outletField, this.springField, this.seepageField];
    return fields.map((f, i) => ({
      field: f.name,
      region: { ...s.columns, name: f.name, byteLength, byteOffset: s.columns.byteOffset + (i + 1) * byteLength },
      tick,
      cell,
    }));
  }

  stateRegions(): readonly Region[] {
    const s = this.requireState();
    return [s.defaults, s.controls, s.sides, s.columns, s.budget, s.cell];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Bind all groundwater outlets to the cell centres on a co-located ShallowWaterSolver. */
  shallowInput(): ShallowRunoffInput {
    const { grid, n, dx, dz } = this.requireState();
    const x0 = grid.centre[0] - grid.width * 0.5;
    const z0 = grid.centre[1] - grid.depth * 0.5;
    return {
      field: this.outletField,
      outlets: Array.from({ length: n }, (_, sourceCell) => ({
        sourceCell,
        position: [
          x0 + ((sourceCell % grid.columns) + 0.5) * dx,
          z0 + (Math.floor(sourceCell / grid.columns) + 0.5) * dz,
        ],
      })),
    };
  }

  /** Read the water table and outlets at an integer column and row. */
  read(column: number, row: number): GroundwaterSample {
    const s = this.requireState();
    const { columns, rows } = s.grid;
    if (
      !Number.isInteger(column) ||
      !Number.isInteger(row) ||
      column < 0 ||
      row < 0 ||
      column >= columns ||
      row >= rows
    )
      throw new RangeError('Invalid groundwater cell; pass an integer column and row inside the grid.');
    const i = row * columns + column;
    const values = floats(s.host, s.columns);
    const thickness = values[THICKNESS * s.n + i]!;
    return {
      head: values[HEAD * s.n + i]!,
      thickness,
      storage: thickness * s.area * floats(s.host, s.controls)[3 * s.n + i]!,
      spring: values[SPRINGS * s.n + i]!,
      seepage: values[SEEPAGE * s.n + i]!,
    };
  }

  /** Read the current drainable water and cumulative volume balance. */
  get budget(): GroundwaterBudget {
    const s = this.requireState();
    const depth = floats(s.host, s.columns);
    const properties = floats(s.host, s.controls);
    let storage = 0;
    for (let i = 0; i < s.n; i++) storage += depth[i]! * properties[3 * s.n + i]! * s.area;
    const [recharge, boundaryIn, boundaryOut, spring, seepage] = floats(s.host, s.budget);
    return {
      storage,
      recharge: recharge!,
      boundaryIn: boundaryIn!,
      boundaryOut: boundaryOut!,
      spring: spring!,
      seepage: seepage!,
    };
  }

  private requireState(): State {
    if (!this.state)
      throw new MargoError('failed', 'Groundwater is not attached; add it to a PhysicsWorld with an aquifer grid.');
    return this.state;
  }
}

export {
  type ConfinedFlow,
  type ConfinedFlowInput,
  heleShawTransmissivity,
  solveConfinedFlow,
  type Streamline,
  type StreamlineOptions,
  streamlinePoint,
  traceStreamlines,
} from './confined.js';
