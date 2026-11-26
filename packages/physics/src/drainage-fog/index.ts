import { MargoError } from '@margoengine/math/errors';
import type { Wind } from '@margoengine/math/fields';
import { gravityMagnitude } from '@margoengine/math/gravity';
import { exp } from '@margoengine/math/pinned';
import { BED_FIELD, BED_LAYOUT } from '../earth/bed.js';
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

const FREEZING = 273.15;
const CP = 1005;
const LV = 2500000;
const SIZE = 9;
const LAYOUT = 1;
const ORIGIN: Cell = [0, 0, 0];
type GridValue = number | ArrayLike<number>;
type Side = 'minX' | 'maxX' | 'minZ' | 'maxZ';

/** Cell-centred geometry, initial state and background conditions for {@link DrainageFog}. */
export interface DrainageFogParams {
  readonly width: number;
  readonly depth: number;
  /** Metres between column centres on X and Z. Defaults to [10, 10]. */
  readonly spacing?: readonly [number, number];
  /** First column centre in the world cell, metres. Defaults to [0, 0]. */
  readonly origin?: readonly [number, number];
  /** Floor elevations in metres. Default flat. */
  readonly terrain?: GridValue;
  /** Starting layer thickness, metres. Defaults to 4. */
  readonly initialDepth?: GridValue;
  /** Starting temperature, kelvin. Defaults to ambient temperature. */
  readonly initialTemperature?: GridValue;
  /** Starting relative humidity fraction. Defaults to ambient humidity. */
  readonly initialHumidity?: GridValue;
  /** Starting cloud water in kg/kg dry air. Defaults to zero. */
  readonly initialLiquid?: GridValue;
  /** Starting horizontal flow in m/s, as X and Z rows. Defaults to still air. */
  readonly initialVelocity?: readonly [GridValue, GridValue];
  /** Surrounding atmosphere temperature in K. Default 284.15. */
  readonly airTemperature?: GridValue;
  /** Surrounding atmosphere relative humidity. Default 0.95. */
  readonly airHumidity?: GridValue;
  /** Thermodynamic pressure in Pa. Default 101325. */
  readonly pressure?: GridValue;
  /** Reference dry air density in kg/m³. Default 1.225. */
  readonly airDensity?: number;
  /** Mean background wind in m/s, X then Z. Defaults to zero. */
  readonly windVelocity?: readonly [GridValue, GridValue];
  /** Sample the background wind at the centre of each evolving layer, overriding windVelocity. */
  readonly wind?: Wind;
  /** Cell size for translating positions into the Wind contract's cell, metres. Defaults to 4096. */
  readonly worldCellSize?: number;
  /** Additional surface heat flux into the air in W/m². Defaults to zero. */
  readonly heat?: GridValue;
  /** Signed moisture from the ground, kg/(m² s). Defaults to zero. */
  readonly moisture?: GridValue;
  /** Effective clear-sky temperature in K. Defaults to 263.15. */
  readonly skyTemperature?: GridValue;
  /** Layer effective longwave emissivity. Defaults to 0.15, or zero for input fluxes only. */
  readonly emissivity?: number;
  /** Dimensionless background shear drag. Defaults to 0.008. */
  readonly drag?: number;
  /** Neutral interfacial entrainment coefficient. Defaults to 0.02. */
  readonly entrainment?: number;
  /** Monodisperse droplet radius in metres. Defaults to 8 µm. */
  readonly radius?: number;
  /** Multiplier for Stokes settling. Defaults to 1. */
  readonly settling?: number;
  /** Open boundary sides export water and air. Defaults to closed on every side. */
  readonly open?: Readonly<Partial<Record<Side, boolean>>>;
  /** Simulated seconds per PhysicsWorld second. Defaults to one. */
  readonly secondsPerSecond?: number;
}

/** A layout-1 f64 or f32 flux input, of one row or one row per fog column. */
export interface DrainageFogInput {
  readonly field: FieldDescriptor;
  /** Words per record. Defaults to one. */
  readonly stride?: number;
  /** Word in each record to read. Defaults to 0. */
  readonly word?: number;
}

/** Bind upstream solvers through the PhysicsWorld registry. */
export interface DrainageFogLoadOptions {
  readonly id?: string;
  readonly signal?: AbortSignal;
  /** Sensible heat into the air, W/m². ATMO-09's energy field uses stride 5, word 1. */
  readonly heat?: DrainageFogInput;
  /** Moisture into the air, kg/(m² s). ATMO-09's water field uses stride 3, word 0. */
  readonly moisture?: DrainageFogInput;
  /** Sample the live TerrainBed beneath the same cell-centred grid. Defaults to false. */
  readonly followTerrain?: boolean;
}

/** The latest resolved shallow atmospheric column. */
export interface DrainageFogSample {
  readonly ground: number;
  readonly depth: number;
  readonly velocity: readonly [number, number];
  readonly temperature: number;
  /** Vapour and liquid mixing ratios, kg/kg dry air. */
  readonly vapour: number;
  readonly liquid: number;
  /** Visible extinction, m⁻¹. */
  readonly extinction: number;
  /** Fog water settling out to the ground, kg/(m² s). */
  readonly settling: number;
}

/** Mass ledger over the whole model, in kilograms. */
export interface DrainageFogBudget {
  readonly air: number;
  readonly water: number;
  readonly entrainedAir: number;
  readonly entrainedWater: number;
  readonly surfaceWater: number;
  readonly exportedAir: number;
  readonly exportedWater: number;
  readonly deposited: number;
}

interface Kernel extends WebAssembly.Exports {
  readonly __stack_pointer: WebAssembly.Global;
  readonly __data_end: WebAssembly.Global;
  fog_step(
    state: number,
    next: number,
    local: number,
    forcing: number,
    settings: number,
    departure: number,
    settling: number,
    ledger: number,
    output: number,
    optical: number,
    width: number,
    depth: number,
    open: number,
    time: number,
    tickDt: number,
  ): void;
}

interface State {
  readonly host: SolverHost;
  readonly kernel: Kernel;
  readonly width: number;
  readonly depth: number;
  readonly count: number;
  readonly origin: readonly [number, number];
  readonly spacing: readonly [number, number];
  readonly open: number;
  readonly wind?: Wind;
  readonly worldCellSize: number;
  readonly scale: number;
  readonly airDensity: number;
  readonly columns: Region;
  readonly scratch: Region;
  readonly phase: Region;
  readonly defaults: Region;
  readonly forcing: Region;
  readonly settings: Region;
  readonly departure: Region;
  readonly settling: Region;
  readonly ledger: Region;
  readonly output: Region;
  readonly optical: Region;
  readonly clock: Region;
}

type Bound = Readonly<{ input: Required<DrainageFogInput>; slot: number; label: string }>;

function bound(input: DrainageFogInput, slot: number, unit: string, label: string): Bound {
  const { field, word = 0, stride = 1 } = input;
  if (field.unit !== unit || !Number.isSafeInteger(stride) || !Number.isSafeInteger(word) || word < 0 || word >= stride)
    throw new RangeError(
      `Invalid drainage fog ${label} binding. Use ${unit} and a valid word within a positive stride.`,
    );
  return { input: { field: { ...field }, stride, word }, slot, label };
}

function checked(value: number, label: string, min = -Infinity, max = Infinity): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new RangeError(
      `Invalid drainage fog ${label}. Pass a finite number from ${min} to ${max} in the documented units.`,
    );
  return value;
}

function gridCell(value: GridValue, index: number, count: number, label: string, min?: number, max?: number): number {
  if (typeof value !== 'number' && value.length !== count)
    throw new RangeError(`Invalid drainage fog ${label} shape. Supply a scalar or ${count} x-fast column values.`);
  return checked(typeof value === 'number' ? value : value[index]!, label, min, max);
}

function mixingRatio(temp: number, pressure: number, humidity: number): number {
  if (humidity === 0 || temp <= 29.65) return 0;
  const celsius = temp - FREEZING;
  const partial = 611.2 * exp((17.67 * celsius) / (celsius + 243.5)) * humidity;
  if (partial >= pressure)
    throw new RangeError(
      'Drainage fog vapour pressure exceeds its atmosphere. Lower temperature or humidity, or raise total pressure.',
    );
  return (0.622 * partial) / (pressure - partial);
}

function words(s: State, region: Region): Float64Array {
  return regionWords(s.host.memory, region) as Float64Array;
}

function field(name: string, quantity: string, unit: string): FieldDescriptor {
  return { name, quantity, unit, kind: 'uniformGrid', centring: 'cell' };
}

function sameCell(a: Cell, b: Cell): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (url.protocol === 'file:') {
    const node = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ node);
    return WebAssembly.compile(await readFile(url, { signal }));
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new MargoError(
      'failed',
      'Drainage fog Wasm could not be loaded. Serve the optional entry with both Wasm assets.',
    );
  return WebAssembly.compile(await response.arrayBuffer());
}

/** A shallow cold-air layer carrying heat, water vapour and radiatively formed droplets. */
export class DrainageFog implements Solver<DrainageFogParams> {
  /** Layout-1 f32 four-word optical cells [ground, top, extinction, 0]. */
  readonly opticalField: FieldDescriptor;
  /** Layout-1 f64 columns [ground, depth, vx, vz, temperature, vapour, liquid, extinction, settling]. */
  readonly columnField: FieldDescriptor;
  private readonly id: string;
  private readonly followTerrain: boolean;
  private readonly sources: readonly Bound[];
  private readonly windSample = { velocity: [0, 0, 0] as [number, number, number], density: 0, temperature: 0 };
  private state?: State;

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    options: DrainageFogLoadOptions,
  ) {
    this.id = options.id ?? 'drainage-fog';
    this.followTerrain = options.followTerrain ?? false;
    const sources: Bound[] = [];
    if (options.heat) sources.push(bound(options.heat, 5, 'W/m^2', 'heat'));
    if (options.moisture) sources.push(bound(options.moisture, 6, 'kg/(m^2 s)', 'moisture'));
    this.sources = sources;
    this.opticalField = field(`${this.id}:optical`, 'fogOpticalCell', 'record');
    this.columnField = field(`${this.id}:columns`, 'moistAirColumn', 'record');
  }

  /** Loads both Wasm memory variants supported by the current host. */
  static async load(options: DrainageFogLoadOptions = {}): Promise<DrainageFog> {
    const { signal } = options;
    const [plain, shared] = await Promise.all([
      compile(new URL(/* @vite-ignore */ './drainage-fog-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? compile(new URL(/* @vite-ignore */ './drainage-fog-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    return new DrainageFog(plain, shared, options);
  }

  describe(): SolverDescription {
    const fields: FieldUse[] = this.sources.map(({ input }) => ({ field: input.field, access: 'read' }));
    if (this.followTerrain) fields.push({ field: BED_FIELD, access: 'read' });
    for (const field of [this.opticalField, this.columnField]) fields.push({ field, access: 'write' });
    return { id: this.id, fields, rate: 0, stableRate: () => 0 };
  }

  init(host: SolverHost, params: DrainageFogParams): void {
    if (!params) throw new RangeError('Drainage fog needs a grid. Pass positive width, depth and column spacing.');
    const { width, depth } = params;
    const count = width * depth;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(depth) ||
      width < 1 ||
      depth < 1 ||
      count * 8 * SIZE >= 0x100000000
    )
      throw new RangeError('Invalid drainage fog grid. Choose positive whole counts fitting the world memory.');
    const [dx, dz] = params.spacing ?? [10, 10];
    const [x0, z0] = params.origin ?? [0, 0];
    const spacing = [checked(dx, 'X spacing', Number.MIN_VALUE), checked(dz, 'Z spacing', Number.MIN_VALUE)] as const;
    const origin = [checked(x0, 'origin X'), checked(z0, 'origin Z')] as const;
    const gravity = checked(gravityMagnitude(host.gravity), 'gravity', Number.MIN_VALUE);
    const airDensity = checked(params.airDensity ?? 1.225, 'air density', Number.MIN_VALUE);
    const radius = checked(params.radius ?? 8e-6, 'droplet radius', Number.MIN_VALUE);
    const setting = [
      gravity,
      airDensity,
      checked(params.drag ?? 0.008, 'surface drag', 0),
      checked(params.entrainment ?? 0.02, 'entrainment', 0),
      checked(params.emissivity ?? 0.15, 'emissivity', 0, 1),
      (checked(params.settling ?? 1, 'settling multiplier', 0) * (2 * 1000 * gravity * radius * radius)) /
        (9 * 1.81e-5),
      3 / (2 * 1000 * radius),
      dx,
      dz,
    ];
    const flags = params.open;
    const open = (flags?.minX ? 1 : 0) | (flags?.maxX ? 2 : 0) | (flags?.minZ ? 4 : 0) | (flags?.maxZ ? 8 : 0);
    const module =
      isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]'
        ? this.shared
        : this.plain;
    if (!module)
      throw new MargoError(
        'unsupported',
        'Shared drainage fog Wasm is unavailable. Use plain world memory on this host.',
      );
    const stack = host.allocate('fog-stack', STACK_BYTES + 8, 'u8', LAYOUT);
    const kernel = new WebAssembly.Instance(module, { env: { memory: host.memory } }).exports as Kernel;
    if (
      !(kernel.__stack_pointer instanceof WebAssembly.Global) ||
      !(kernel.__data_end instanceof WebAssembly.Global) ||
      kernel.__data_end.value !== 0
    )
      throw new MargoError('failed', 'Drainage fog has an invalid Wasm layout. Rebuild the slot-free native variants.');
    kernel.__stack_pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
    const allocate = (label: string, size: number): Region => host.allocate(`fog-${label}`, 8 * size, 'f64', LAYOUT);
    const s: State = {
      host,
      kernel,
      width,
      depth,
      count,
      origin,
      spacing,
      open,
      wind: params.wind,
      airDensity,
      worldCellSize: checked(params.worldCellSize ?? 4096, 'world cell size', 1),
      scale: checked(params.secondsPerSecond ?? 1, 'time scale', Number.MIN_VALUE),
      columns: allocate('columns', 5 * count),
      scratch: allocate('transport', 5 * count),
      phase: allocate('phase', 4 * count),
      defaults: allocate('defaults', SIZE * count),
      forcing: allocate('forcing', SIZE * count),
      settings: allocate('settings', setting.length),
      departure: allocate('departure', count),
      settling: allocate('settling', count),
      ledger: allocate('ledger', 6),
      output: allocate('diagnostics', SIZE * count),
      optical: host.allocate('fog-optical', 16 * count, 'f32', LAYOUT),
      clock: allocate('clock', 4),
    };
    words(s, s.settings).set(setting);
    const columns = words(s, s.columns),
      defaults = words(s, s.defaults);
    const initial = params.initialVelocity ?? [0, 0];
    const wind = params.windVelocity ?? [0, 0];
    for (let i = 0; i < count; i++) {
      const value = (grid: GridValue, name: string, min?: number, max?: number) =>
        gridCell(grid, i, count, name, min, max);
      const ambient = value(params.airTemperature ?? 284.15, 'ambient temperature', Number.MIN_VALUE);
      const humidity = value(params.airHumidity ?? 0.95, 'ambient humidity', 0, 1);
      const pressure = value(params.pressure ?? 101325, 'air pressure', Number.MIN_VALUE);
      defaults.set(
        [
          value(params.terrain ?? 0, 'ground'),
          ambient,
          mixingRatio(ambient, pressure, humidity),
          value(wind[0], 'wind X'),
          value(wind[1], 'wind Z'),
          value(params.heat ?? 0, 'heat'),
          value(params.moisture ?? 0, 'moisture'),
          value(params.skyTemperature ?? 263.15, 'sky temperature', Number.MIN_VALUE),
          pressure,
        ],
        SIZE * i,
      );
      const h = value(params.initialDepth ?? 4, 'initial depth', 0);
      const temp = value(params.initialTemperature ?? ambient, 'initial temperature', Number.MIN_VALUE);
      const vapour = mixingRatio(temp, pressure, value(params.initialHumidity ?? humidity, 'initial humidity', 0, 1));
      const liquid = value(params.initialLiquid ?? 0, 'initial liquid', 0);
      columns.set(
        [
          h,
          h * value(initial[0], 'initial velocity X'),
          h * value(initial[1], 'initial velocity Z'),
          h * (CP * (temp - FREEZING) + LV * vapour),
          h * (vapour + liquid),
        ],
        5 * i,
      );
    }
    this.state = s;
    this.run(s, 0, { tick: -1, level: 0, seed: 0, cell: ORIGIN, inputs: new Map() });
  }

  importPorts(): void {
    /* Registry inputs arrive through StepContext. */
  }

  step(context: StepContext, dt: number): void {
    this.run(this.requireState(), dt, context);
  }

  private run(s: State, dt: number, context: StepContext): void {
    const input = words(s, s.forcing);
    input.set(words(s, s.defaults));
    for (const { input: source, slot, label } of this.sources) {
      const port = context.inputs.get(source.field.name);
      if (!port) continue;
      const r = port.region;
      if (r.layout !== LAYOUT || (r.type !== 'f64' && r.type !== 'f32') || !sameCell(port.cell, context.cell))
        throw new RangeError(`Invalid drainage fog ${label} port. Use layout-1 floats in this world cell.`);
      const values = regionWords(s.host.memory, r);
      const uniform = values.length === source.stride;
      if (!uniform && values.length !== s.count * source.stride)
        throw new RangeError(`Invalid drainage fog ${label} size. Give a uniform record or one record per cell.`);
      for (let i = 0; i < s.count; i++) {
        input[i * SIZE + slot] = checked(values[(uniform ? 0 : i * source.stride) + source.word]!, label);
      }
    }
    const bed = this.followTerrain && context.inputs.get(BED_FIELD.name);
    if (bed) {
      const r = bed.region;
      if (
        r.type !== 'f32' ||
        r.layout !== BED_LAYOUT ||
        r.byteLength !== 4 * (s.width + 1) * (s.depth + 1) ||
        !sameCell(bed.cell, context.cell)
      )
        throw new RangeError(
          'Invalid drainage fog bed input. Attach a TerrainBed with matching cells in the same world cell.',
        );
      const h = regionWords(s.host.memory, r),
        stride = s.depth + 1;
      for (let z = 0; z < s.depth; z++)
        for (let x = 0; x < s.width; x++) {
          const i = z + x * stride;
          input[(x + z * s.width) * SIZE] = (h[i + 1]! + h[i + stride]!) * 0.5;
        }
    }
    if (s.wind && dt > 0) {
      const wind = s.wind;
      const shift = (axis: number) => (context.cell[axis]! - wind.cell[axis]!) * s.worldCellSize;
      const column = words(s, s.columns);
      for (let i = 0; i < s.count; i++) {
        const k = SIZE * i;
        const flow = wind.sample(
          s.origin[0] + (i % s.width) * s.spacing[0] + shift(0),
          input[k]! + column[5 * i]! * 0.5 + shift(1),
          s.origin[1] + Math.floor(i / s.width) * s.spacing[1] + shift(2),
          context.tick * dt,
          this.windSample,
        );
        input[k + 3] = checked(flow.velocity[0], 'sampled wind X');
        input[k + 4] = checked(flow.velocity[2], 'sampled wind Z');
      }
    }
    s.kernel.fog_step(
      s.columns.byteOffset,
      s.scratch.byteOffset,
      s.phase.byteOffset,
      s.forcing.byteOffset,
      s.settings.byteOffset,
      s.departure.byteOffset,
      s.settling.byteOffset,
      s.ledger.byteOffset,
      s.output.byteOffset,
      s.optical.byteOffset,
      s.width,
      s.depth,
      s.open,
      dt * s.scale,
      dt || 1,
    );
    words(s, s.clock).set([...context.cell, context.tick + 1]);
  }

  exportPorts(tick: number): readonly Port[] {
    const s = this.requireState();
    const [x, y, z] = words(s, s.clock);
    const cell: Cell = [x!, y!, z!];
    return [
      { field: this.opticalField.name, region: s.optical, tick, cell },
      { field: this.columnField.name, region: s.output, tick, cell },
    ];
  }

  stateRegions(): readonly Region[] {
    const s = this.requireState();
    return [s.columns, s.defaults, s.settings, s.ledger, s.output, s.optical, s.clock];
  }

  extraState(): readonly Region[] {
    return [];
  }

  get width(): number {
    return this.requireState().width;
  }
  get depth(): number {
    return this.requireState().depth;
  }
  get spacing(): readonly [number, number] {
    return this.requireState().spacing;
  }
  get origin(): readonly [number, number] {
    return this.requireState().origin;
  }
  /** Revision of the renderable sampled columns on the solver clock. */
  get revision(): number {
    const s = this.requireState();
    return words(s, s.clock)[3]!;
  }

  /** Copy optical rows into a caller-provided buffer of length 4 * width * depth. */
  writeColumnData(target: Float32Array): void {
    const s = this.requireState();
    if (!(target instanceof Float32Array) || target.length !== s.count * 4)
      throw new RangeError('Wrong drainage fog optical buffer. Give a Float32Array of length 4 * width * depth.');
    target.set(regionWords(s.host.memory, s.optical));
  }

  /** Read a column at integer x and z indices. */
  read(x: number, z: number): DrainageFogSample {
    const s = this.requireState();
    if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || z < 0 || x >= s.width || z >= s.depth)
      throw new RangeError('Invalid drainage fog column. Pass integer X and Z indices inside the grid.');
    const values = words(s, s.output);
    const k = (x + z * s.width) * SIZE;
    return {
      ground: values[k]!,
      depth: values[k + 1]!,
      velocity: [values[k + 2]!, values[k + 3]!],
      temperature: values[k + 4]!,
      vapour: values[k + 5]!,
      liquid: values[k + 6]!,
      extinction: values[k + 7]!,
      settling: values[k + 8]!,
    };
  }

  /** Mass accounting across all cells, including water moved out by settling. */
  get budget(): DrainageFogBudget {
    const s = this.requireState(),
      values = words(s, s.columns);
    let air = 0,
      water = 0;
    for (let i = 0; i < s.count; i++) {
      air += values[5 * i]!;
      water += values[5 * i + 4]!;
    }
    const factor = s.spacing[0] * s.spacing[1] * s.airDensity;
    const [entrainedAir, entrainedWater, surfaceWater, exportedAir, exportedWater, deposited] = words(s, s.ledger);
    return {
      air: air * factor,
      water: water * factor,
      entrainedAir: entrainedAir!,
      entrainedWater: entrainedWater!,
      surfaceWater: surfaceWater!,
      exportedAir: exportedAir!,
      exportedWater: exportedWater!,
      deposited: deposited!,
    };
  }

  private requireState(): State {
    if (!this.state)
      throw new MargoError('state', 'Drainage fog is not attached. Add it to a PhysicsWorld with a grid first.');
    return this.state;
  }
}
