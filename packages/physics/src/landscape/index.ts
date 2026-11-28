import { MargoError } from '@margoengine/math/errors';
import { gravityMagnitude } from '@margoengine/math/gravity';
import { type BedShape, BedChange, BED_CHANGE_FIELD, BED_FIELD, BED_LAYOUT, bedVertexCount } from '../earth/bed.js';
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

const LAYOUT = 1;
const F64 = Float64Array.BYTES_PER_ELEMENT;
const DISCHARGE = 0;
const INCISION = 1;
const SEDIMENT = 2;
const STATE_PLANES = 3;

type Scalars = number | ArrayLike<number>;
type Sides = 'minX' | 'maxX' | 'minZ' | 'maxZ';

/** The physical properties of a grain class released by incision and carried downhill. */
export interface LandscapeGrain {
  /** Representative grain diameter, metres. */
  readonly diameter: number;
  /** Fraction of the parent material in this class. The supplied fractions are normalised to sum to one. */
  readonly fraction: number;
  /** Grain density, kg/m³. Default 2650. */
  readonly density?: number;
  /** Critical Shields number, dimensionless. Default 0.0495. */
  readonly criticalShields?: number;
  /** Mean travel length for fall-out, metres. Default zero uses equilibrium transport capacity alone. */
  readonly travelLength?: number;
}

/** Optional fields for rainfall and stabilisation, and the load's lifetime. */
export interface LandscapeLoadOptions {
  /** Solver ID and prefix of the output fields. Defaults to 'landscape'. */
  readonly id?: string;
  /** Layout-1 vertex rainfall in m/s, or a cell-centred scalar on the bed's rectangle. */
  readonly rainField?: FieldDescriptor;
  /** Layout-1 time-averaged shear in Pa, such as SedimentTransport.shearField. */
  readonly shearField?: FieldDescriptor;
  /** Layout-1 root stabilisation pressure in Pa. Accepts cell or vertex samples. */
  readonly rootCohesionField?: FieldDescriptor;
  /** Cancels loading with the signal's reason. */
  readonly signal?: AbortSignal;
}

/** A landscape on the same vertex grid as its TerrainBed. Rates and distances use SI units. */
export interface LandscapeParams {
  /** Grid of the TerrainBed receiving the change. Vertex arrays use z-fast order. */
  readonly grid: BedShape;
  /** Effective rainfall in m/s, scalar or per vertex. Defaults to 1 m per Julian year (31,557,600 s). */
  readonly rainfall?: Scalars;
  /** Tectonic vertical velocity in m/s, scalar or per vertex. Default zero; negative values subside. */
  readonly uplift?: Scalars;
  /** Minimum elevations in metres. Defaults to no floor. Match the TerrainBed's floor when it has one. */
  readonly floor?: Scalars;
  /** Geological seconds represented by one second of world time. Default 1. */
  readonly secondsPerSecond?: number;
  /** Coefficient K in K Q^m S, yielding m/s at Q in m³/s. Default 1e-11. */
  readonly erodibility?: number;
  /** Discharge exponent m in the stream-power law. Default 0.5. */
  readonly dischargeExponent?: number;
  /** Threshold for mechanical rock incision, Pa. Default zero. */
  readonly bedrockThreshold?: number;
  /** Manning roughness (s/m^(1/3)) for the equilibrium depth estimate. Default 0.03. */
  readonly manning?: number;
  /** Water density in kg/m³. Default 1000. */
  readonly waterDensity?: number;
  /** Uniform pore volume fraction of the bed, in [0, 1). Default 0.4. */
  readonly porosity?: number;
  /** Initial depth of loose sediment in metres. Default 0.1; below it incision exposes parent material. */
  readonly alluvialDepth?: Scalars;
  /** Mixture exposed by rock incision. Default one medium-sand class (0.0003 m). */
  readonly grains?: readonly LandscapeGrain[];
  /** Linear hillslope diffusivity in m²/s. Default 1e-8. */
  readonly hillslopeDiffusivity?: number;
  /** Thermal/granular transfer diffusivity above the talus slope, m²/s. Default 1e-7. */
  readonly thermalDiffusivity?: number;
  /** Critical rise/run above which thermal transfer is active. Default tan(30 degrees). */
  readonly talusSlope?: number;
  /** Fixed-height edges that export water and sediment. Defaults to all closed. */
  readonly outlets?: Readonly<Partial<Record<Sides, boolean>>>;
}

/** Current hydrology and rock incision of one landscape vertex. */
export interface LandscapeSample {
  /** Upstream runoff discharge, m³/s. */
  readonly discharge: number;
  /** Gross incision rate before local redeposition, metres per geological second. */
  readonly incision: number;
  /** Outgoing bulk sediment flux, m³ per geological second. */
  readonly sedimentFlux: number;
  /** Bulk volume of loose surface material in each grain class, m³. */
  readonly alluvium: readonly number[];
}

/** The cumulative sediment budget and geological clock. Spatial volumes include bed pores. */
export interface LandscapeBudget {
  /** Evolved physical time in seconds. */
  readonly elapsed: number;
  /** Signed terrain volume supplied by uplift and subsidence, m³. */
  readonly uplift: number;
  /** Loose sediment on the terrain, m³. */
  readonly alluvium: number;
  /** Volume exported through fixed outlets, m³, one value per grain class. */
  readonly exported: readonly number[];
}

interface NativeKernel extends WebAssembly.Exports {
  landscape_step(
    input: number,
    constants: number,
    settings: number,
    grains: number,
    state: number,
    bedDelta: number,
    budget: number,
    scratch: number,
    topology: number,
    nx: number,
    nz: number,
    dx: number,
    dz: number,
    nGrains: number,
    outletMask: number,
    dt: number,
  ): number;
}

interface State {
  readonly host: SolverHost;
  readonly kernel: NativeKernel;
  readonly grid: BedShape;
  readonly n: number;
  readonly nGrains: number;
  readonly timeScale: number;
  readonly outlets: number;
  readonly change: BedChange;
  readonly baseRain: Region;
  readonly constants: Region;
  readonly settings: Region;
  readonly grains: Region;
  readonly input: Region;
  readonly columns: Region;
  readonly candidate: Region;
  readonly candidateDelta: Region;
  readonly budget: Region;
  readonly candidateBudget: Region;
  readonly scratch: Region;
  readonly topology: Region;
  readonly cell: Region;
}

function checked(label: string, value: number, min: number, max = Infinity): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new MargoError('state', `Invalid landscape ${label}. Pass a finite value between ${min} and ${max}.`);
  return value;
}

function fill(target: Float64Array, value: Scalars, label: string, min: number): void {
  if (typeof value === 'number') {
    target.fill(checked(label, value, min));
    return;
  }
  if (value?.length !== target.length)
    throw new MargoError(
      'state',
      `Invalid landscape ${label} length. Pass one value or ${target.length} vertex values.`,
    );
  for (let i = 0; i < target.length; i++) target[i] = checked(label, value[i]!, min);
}

function output(name: string, quantity: string, unit: string): FieldDescriptor {
  return { name, kind: 'uniformGrid', quantity, unit, centring: 'vertex' };
}

function inputField(field: FieldDescriptor | undefined, unit: string): FieldDescriptor | undefined {
  if (!field) return undefined;
  if (!field.name || field.unit !== unit || (field.centring !== 'vertex' && field.centring !== 'cell'))
    throw new MargoError(
      'state',
      `Invalid landscape field ${field.name}. Supply a named cell or vertex field in ${unit}.`,
    );
  return { ...field };
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
  if (!response.ok) {
    throw new MargoError('failed', `Landscape kernel HTTP ${response.status}. Serve the matching landscape Wasm file.`);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

function floats(host: SolverHost, region: Region): Float64Array {
  return regionWords(host.memory, region) as Float64Array;
}

function landscapeVertexCount(grid: BedShape): number {
  try {
    return bedVertexCount(grid);
  } catch (cause) {
    throw Object.assign(new MargoError('state', 'Invalid landscape bed grid. Pass a valid TerrainBed rectangle.'), {
      cause,
    });
  }
}

function checkGridAxis(axis: string, centre: number, width: number, cells: number): number {
  const left = centre - width * 0.5;
  const right = centre + width * 0.5;
  const spacing = width / cells;
  const next = left + spacing;
  const previous = right - spacing;
  if (!(Number.isFinite(next) && Number.isFinite(previous) && next > left && previous < right))
    throw new MargoError(
      'state',
      `Landscape ${axis} vertices exceed coordinate resolution. Use a nearer local origin.`,
    );
  return spacing;
}

function readInput(source: FieldDescriptor, port: Port, state: State, cell: Cell, out: Float64Array): void {
  const { columns: nx, rows: nz } = state.grid;
  const cells = source.centring === 'cell';
  const expected = cells ? nx * nz : state.n;
  const { region } = port;
  if (
    region.layout !== LAYOUT ||
    (region.type !== 'f32' && region.type !== 'f64') ||
    region.byteLength !== expected * (region.type === 'f32' ? 4 : F64) ||
    !port.cell.every((coordinate, i) => coordinate === cell[i])
  ) {
    throw new MargoError(
      'state',
      `Invalid landscape port ${source.name}. Publish one layout-1 scalar in each matching grid location.`,
    );
  }
  const values = regionWords(state.host.memory, region);
  for (let i = 0; i < values.length; i++) checked(source.name, values[i]!, 0);
  if (!cells) {
    out.set(values);
    return;
  }
  // Transfer each x-fast cell over its four z-fast vertices in proportion to triangle support.
  for (let x = 0; x <= nx; x++) {
    const firstColumn = Math.max(0, x - 1);
    const lastColumn = Math.min(nx - 1, x);
    for (let z = 0; z <= nz; z++) {
      const firstRow = Math.max(0, z - 1);
      const lastRow = Math.min(nz - 1, z);
      let total = 0;
      let weights = 0;
      for (let j = firstRow; j <= lastRow; j++) {
        for (let k = firstColumn; k <= lastColumn; k++) {
          const weight = (z === j) === (x === k) ? 1 : 2;
          total += weight * values[j * nx + k]!;
          weights += weight;
        }
      }
      let average = total / weights;
      if (!Number.isFinite(average)) {
        // Every input is finite and nonnegative. Fold the weighted mean without forming the large sum.
        average = 0;
        let included = 0;
        for (let j = firstRow; j <= lastRow; j++) {
          for (let k = firstColumn; k <= lastColumn; k++) {
            const weight = (z === j) === (x === k) ? 1 : 2;
            included += weight;
            average += (values[j * nx + k]! - average) * (weight / included);
          }
        }
      }
      out[x * (nz + 1) + z] = checked(source.name, average, 0);
    }
  }
}

/** Multidirectional runoff, implicit stream incision and conservative mountain and soil evolution. */
export class LandscapeEvolution implements Solver<LandscapeParams> {
  /** Vertex discharge field, layout-1 f64 in m³/s. */
  readonly dischargeField: FieldDescriptor;
  /** Gross vertex incision field, layout-1 f64 in m/s. */
  readonly incisionField: FieldDescriptor;
  /** Vertex outgoing sediment field, layout-1 f64 in m³/s. */
  readonly sedimentField: FieldDescriptor;
  private readonly id: string;
  private readonly rain?: FieldDescriptor;
  private readonly shear?: FieldDescriptor;
  private readonly roots?: FieldDescriptor;
  private state?: State;

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    options: LandscapeLoadOptions,
  ) {
    this.id = options.id ?? 'landscape';
    if (typeof this.id !== 'string' || !this.id.trim() || this.id !== this.id.trim())
      throw new MargoError('state', 'Invalid landscape solver ID. Use a nonempty name without outer whitespace.');
    this.rain = inputField(options.rainField, 'm/s');
    this.shear = inputField(options.shearField, 'Pa');
    this.roots = inputField(options.rootCohesionField, 'Pa');
    this.dischargeField = output(`${this.id}:discharge`, 'volumeDischarge', 'm^3/s');
    this.incisionField = output(`${this.id}:incision`, 'incisionRate', 'm/s');
    this.sedimentField = output(`${this.id}:sediment`, 'sedimentDischarge', 'm^3/s');
  }

  /** Loads the optional native implementation. Add the result alongside a TerrainBed in a PhysicsWorld. */
  static async load(options: LandscapeLoadOptions = {}): Promise<LandscapeEvolution> {
    if (options === null || typeof options !== 'object')
      throw new MargoError('state', 'Invalid landscape load options. Pass an options object or omit it.');
    const { signal } = options;
    let plain: WebAssembly.Module;
    let shared: WebAssembly.Module | undefined;
    try {
      [plain, shared] = await Promise.all([
        readModule(new URL(/* @vite-ignore */ './landscape-kernel.wasm?no-inline', import.meta.url), signal),
        canShareMemory()
          ? readModule(new URL(/* @vite-ignore */ './landscape-kernel-shared.wasm?no-inline', import.meta.url), signal)
          : undefined,
      ]);
      signal?.throwIfAborted();
    } catch (cause) {
      signal?.throwIfAborted();
      if (cause instanceof MargoError) throw cause;
      throw Object.assign(
        new MargoError('failed', 'Landscape Wasm failed to load. Use a SIMD runtime and serve the landscape kernel.'),
        { cause },
      );
    }
    return new LandscapeEvolution(plain, shared, options);
  }

  describe(): SolverDescription {
    const fields: FieldUse[] = [
      { field: BED_FIELD, access: 'read' },
      { field: BED_CHANGE_FIELD, access: 'accumulate' },
      { field: this.dischargeField, access: 'write' },
      { field: this.incisionField, access: 'write' },
      { field: this.sedimentField, access: 'write' },
    ];
    for (const field of [this.rain, this.shear, this.roots]) if (field) fields.push({ field, access: 'read' });
    return { id: this.id, fields, rate: 0, stableRate: () => 0 };
  }

  init(host: SolverHost, params: LandscapeParams): void {
    if (!params?.grid) throw new MargoError('state', 'Landscape needs a bed grid. Pass the TerrainBed grid in metres.');
    const n = landscapeVertexCount(params.grid);
    const grid: BedShape = { ...params.grid, centre: [params.grid.centre[0], params.grid.centre[1]] };
    const dx = checkGridAxis('X', grid.centre[0], grid.width, grid.columns);
    const dz = checkGridAxis('Z', grid.centre[1], grid.depth, grid.rows);
    checked('vertex area', (dx * dz) / 6, Number.MIN_VALUE);
    const grains = params.grains ?? [{ diameter: 0.0003, fraction: 1 }];
    if (!Array.isArray(grains) || !grains.every((grain) => grain && typeof grain === 'object'))
      throw new MargoError('state', 'Invalid landscape grain mixture. Pass an array of diameter and fraction records.');
    const nGrains = grains.length;
    // Include the candidate regions and the world mirrors for the output fields.
    const required = ((31 + 3 * nGrains) * n + 19 + 7 * nGrains) * F64 + DYNAMIC_BASE + STACK_BYTES + 16;
    if (required >= MAX_MEMORY_PAGES * 65536)
      throw new MargoError('state', 'Landscape grid exceeds the wasm32 arena. Use fewer vertices or grain classes.');
    const total = grains.reduce((sum, grain) => sum + checked('grain fraction', grain.fraction, 0), 0);
    if (!Number.isFinite(total) || total <= 0)
      throw new MargoError(
        'state',
        'Invalid landscape grain mixture. Give at least one class with a positive fraction.',
      );
    const density = checked('water density', params.waterDensity ?? 1000, Number.MIN_VALUE);
    const timeScale = checked('time scale', params.secondsPerSecond ?? 1, Number.MIN_VALUE, Number.MAX_VALUE / 60);
    const allocate = (name: string, count: number): Region =>
      host.allocate('landscape-' + name, count * F64, 'f64', LAYOUT);
    const module = isShared(host.memory) ? this.shared : this.plain;
    if (!module)
      throw new MargoError(
        'unsupported',
        'Shared landscape Wasm is unavailable. Choose plain world memory on this host.',
      );
    const stack = host.allocate('landscape-stack', STACK_BYTES + 8, 'u8', LAYOUT);
    const kernel = new WebAssembly.Instance(module, { env: { memory: host.memory } }).exports as NativeKernel;
    const pointer = kernel.__stack_pointer;
    if (!(pointer instanceof WebAssembly.Global))
      throw new MargoError('failed', 'Landscape Wasm has no stack pointer. Rebuild both landscape assets.');
    pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;

    const edges = params.outlets;
    const change = new BedChange(host, grid, 'landscape-bed-change');
    const outlets = (edges?.minX ? 1 : 0) | (edges?.maxX ? 2 : 0) | (edges?.minZ ? 4 : 0) | (edges?.maxZ ? 8 : 0);
    const state: State = {
      host,
      kernel,
      grid,
      n,
      nGrains,
      timeScale,
      outlets,
      change,
      baseRain: allocate('rain', n),
      constants: allocate('vertex-constants', 3 * n),
      settings: allocate('parameters', 10),
      grains: allocate('grains', 5 * nGrains),
      input: allocate('input', 4 * n),
      columns: allocate('state', (STATE_PLANES + nGrains) * n),
      candidate: allocate('candidate-state', (STATE_PLANES + nGrains) * n),
      candidateDelta: allocate('candidate-bed-delta', n),
      budget: allocate('budget', 3 + nGrains),
      candidateBudget: allocate('candidate-budget', 3 + nGrains),
      scratch: allocate('scratch', (6 + nGrains) * n),
      topology: host.allocate('landscape-topology', 2 * n * Uint32Array.BYTES_PER_ELEMENT, 'u32', LAYOUT),
      cell: allocate('cell', 3),
    };
    const alluvium = new Float64Array(n);
    fill(alluvium, params.alluvialDepth ?? 0.1, 'loose soil depth', 0);
    const settings = [
      checked('erodibility', params.erodibility ?? 1e-11, 0),
      checked('discharge exponent', params.dischargeExponent ?? 0.5, 0),
      checked('Manning roughness', params.manning ?? 0.03, 0),
      density,
      checked('gravity magnitude', gravityMagnitude(host.gravity), 0),
      checked('rock shear threshold', params.bedrockThreshold ?? 0, 0),
      checked('porosity', params.porosity ?? 0.4, 0, 1 - Number.EPSILON),
      checked('hillslope diffusivity', params.hillslopeDiffusivity ?? 1e-8, 0),
      checked('thermal diffusivity', params.thermalDiffusivity ?? 1e-7, 0),
      checked('talus slope', params.talusSlope ?? 1 / Math.sqrt(3), 0),
    ];
    floats(host, state.settings).set(settings);
    const controls = floats(host, state.constants);
    controls.set(change.area);
    fill(controls.subarray(n, 2 * n), params.uplift ?? 0, 'uplift', -Infinity);
    const floor = controls.subarray(2 * n, 3 * n);
    if (params.floor === undefined) floor.fill(-Infinity);
    else fill(floor, params.floor, 'bed floor', -Infinity);
    fill(floats(host, state.baseRain), params.rainfall ?? 1 / 31_557_600, 'effective rainfall', 0);
    const classes = floats(host, state.grains);
    const values = floats(host, state.columns);
    const budget = floats(host, state.budget);
    for (let i = 0; i < n; i++)
      budget[2] = checked('initial loose volume', budget[2]! + alluvium[i]! * change.area[i]!, 0);
    for (let k = 0; k < nGrains; k++) {
      const grain = grains[k]!;
      const relativeDensity = checked(
        'grain density ratio',
        checked('grain density', grain.density ?? 2650, density) / density,
        1,
      );
      if (!(relativeDensity > 1))
        throw new MargoError('state', 'Invalid landscape grain density. Choose a grain denser than the ambient water.');
      const fraction = grain.fraction / total;
      classes.set(
        [
          checked('grain diameter', grain.diameter, Number.MIN_VALUE),
          relativeDensity,
          checked('critical Shields number', grain.criticalShields ?? 0.0495, 0),
          fraction,
          checked('grain travel length', grain.travelLength ?? 0, 0),
        ],
        k * 5,
      );
      for (let i = 0; i < n; i++) values[(STATE_PLANES + k) * n + i] = alluvium[i]! * change.area[i]! * fraction;
    }
    floats(host, state.cell).set(host.cell);
    this.state = state;
  }

  importPorts(): void {
    // StepContext holds the bed and forcing mirrors at the coupling tick.
  }

  step(context: StepContext, dt: number): void {
    const state = this.requireState();
    const { grid, host, n } = state;
    const bed = context.inputs.get(BED_FIELD.name);
    if (!bed) {
      state.change.clear();
      return;
    }
    if (
      bed.region.type !== 'f32' ||
      bed.region.layout !== BED_LAYOUT ||
      bed.region.byteLength !== n * Float32Array.BYTES_PER_ELEMENT ||
      !bed.cell.every((coordinate, i) => coordinate === context.cell[i])
    ) {
      throw new MargoError(
        'state',
        'Invalid landscape bed port. Place the matching TerrainBed and landscape grid in one cell.',
      );
    }
    const interval = checked('geological step', dt * state.timeScale, Number.MIN_VALUE);
    const input = floats(host, state.input);
    input.set(regionWords(host.memory, bed.region));
    input.set(floats(host, state.baseRain), n);
    input.fill(-1, 2 * n, 3 * n);
    input.fill(0, 3 * n);
    for (const [index, descriptor] of [this.rain, this.shear, this.roots].entries()) {
      const port = descriptor && context.inputs.get(descriptor.name);
      if (descriptor && port)
        readInput(descriptor, port, state, context.cell, input.subarray((1 + index) * n, (2 + index) * n));
    }
    const accepted = floats(host, state.columns);
    const budget = floats(host, state.budget);
    const candidate = floats(host, state.candidate);
    const delta = floats(host, state.candidateDelta);
    const nextBudget = floats(host, state.candidateBudget);
    candidate.set(accepted);
    nextBudget.set(budget);
    const status = state.kernel.landscape_step(
      state.input.byteOffset,
      state.constants.byteOffset,
      state.settings.byteOffset,
      state.grains.byteOffset,
      state.candidate.byteOffset,
      state.candidateDelta.byteOffset,
      state.candidateBudget.byteOffset,
      state.scratch.byteOffset,
      state.topology.byteOffset,
      grid.columns + 1,
      grid.rows + 1,
      grid.width / grid.columns,
      grid.depth / grid.rows,
      state.nGrains,
      state.outlets,
      interval,
    );
    if (status !== 0)
      throw new MargoError(
        'state',
        'Landscape update exceeds the finite terrain or sediment range. Reduce rates or the geological time scale.',
      );
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(Math.fround(input[i]! + delta[i]!)))
        throw new MargoError(
          'state',
          'Landscape bed exceeds TerrainBed float32 range. Reduce uplift or shorten the geological step.',
        );
    }
    accepted.set(candidate);
    budget.set(nextBudget);
    state.change.deltas.set(delta);
    floats(host, state.cell).set(context.cell);
  }

  exportPorts(tick: number): readonly Port[] {
    const state = this.requireState();
    const cell = state.host.cell;
    const length = state.n * F64;
    const ports: Port[] = [state.change.port(tick, cell)];
    for (const [i, descriptor] of [this.dischargeField, this.incisionField, this.sedimentField].entries()) {
      const region = {
        ...state.columns,
        name: descriptor.name,
        byteOffset: state.columns.byteOffset + i * length,
        byteLength: length,
      };
      ports.push({ field: descriptor.name, region, tick, cell });
    }
    return ports;
  }

  stateRegions(): readonly Region[] {
    const s = this.requireState();
    return [s.baseRain, s.constants, s.settings, s.grains, s.columns, s.change.state, s.budget, s.cell];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Return the current discharge, erosion and sediment at one vertex. */
  read(column: number, row: number): LandscapeSample {
    const { grid, n, nGrains, host, columns } = this.requireState();
    if (
      !Number.isInteger(column) ||
      !Number.isInteger(row) ||
      column < 0 ||
      row < 0 ||
      column > grid.columns ||
      row > grid.rows
    )
      throw new MargoError('state', 'Invalid landscape vertex. Pass integer column and row inside the bed grid.');
    const i = column * (grid.rows + 1) + row;
    const values = floats(host, columns);
    return {
      discharge: values[DISCHARGE * n + i]!,
      incision: values[INCISION * n + i]!,
      sedimentFlux: values[SEDIMENT * n + i]!,
      alluvium: Array.from({ length: nGrains }, (_, k) => values[(STATE_PLANES + k) * n + i]!),
    };
  }

  /** Read the current time, storage and cumulative boundary fluxes. */
  get budget(): LandscapeBudget {
    const state = this.requireState();
    const values = floats(state.host, state.budget);
    return { elapsed: values[0]!, uplift: values[1]!, alluvium: values[2]!, exported: Array.from(values.subarray(3)) };
  }

  private requireState(): State {
    if (!this.state)
      throw new MargoError('failed', 'To attach Landscape, add it to a PhysicsWorld with its terrain grid.');
    return this.state;
  }
}
