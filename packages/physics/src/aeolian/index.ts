import { MargoError } from '@margoengine/math/errors';
import type { FlowSample, Wind } from '@margoengine/math/fields';
import { gravityMagnitude } from '@margoengine/math/gravity';
import { ln } from '@margoengine/math/pinned';
import { type BedShape, BedChange, BED_CHANGE_FIELD, BED_FIELD, BED_LAYOUT } from '../earth/bed.js';
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
type Scalars = number | ArrayLike<number>;
type Side = 'minX' | 'maxX' | 'minZ' | 'maxZ';

/** Fields used by the optional aeolian solver. All vertex arrays have x increasing fastest. */
export interface AeolianLoadOptions {
  /** Solver ID and port prefix. Defaults to 'aeolian'. */
  readonly id?: string;
  /** Vertex triples [friction velocity X, friction velocity Z, air density], in m/s and kg/m³. */
  readonly frictionField?: FieldDescriptor;
  /** Optional vertex scalars giving exposed erodible share in [0, 1]. */
  readonly erodibleField?: FieldDescriptor;
  /** Cancels loading the optional kernel. */
  readonly signal?: AbortSignal;
}

/** Ground, physical material properties and forcing for wind-driven sand or snow. */
export interface AeolianParams {
  /** Grid of the real TerrainBed receiving bed change. Parameter arrays have x increasing fastest. */
  readonly grid: BedShape;
  /** Sand (default) or seasonal blowing snow. */
  readonly material?: 'sand' | 'snow';
  /** Air field sampled at referenceHeight; an input frictionField takes precedence. */
  readonly wind?: Wind;
  /** Prescribed flat-bed [+X, +Z] friction velocity, m/s. Defaults to still air. */
  readonly frictionVelocity?: readonly [number, number];
  /** Density for prescribed friction velocity, kg/m³. Default 1.225. */
  readonly airDensity?: number;
  /** Wind sampling height, metres above the terrain. Default 10. */
  readonly referenceHeight?: number;
  /** Roughness height for the logarithmic profile, metres. Default 0.0001. */
  readonly roughness?: number;
  /** PhysicsWorld cell size when the wind and terrain have different cells. Default 4096 m. */
  readonly cellSize?: number;
  /** Grain diameter, metres. Default 0.00025 for sand or 0.0002 for snow. */
  readonly diameter?: number;
  /** Individual grain density, kg/m³. Defaults to sand 2650 or ice 917. */
  readonly grainDensity?: number;
  /** In-place bulk density of the bed, kg/m³. Defaults to sand 1590 or seasonal snow 300. */
  readonly bulkDensity?: number;
  /** Moving grain speed, m/s. Defaults to 1.5 for sand or 2.8 times the impact threshold for snow. */
  readonly grainSpeed?: number;
  /** Sustaining friction velocity, m/s. Defaults to 80% of Bagnold's fluid threshold for sand or 0.2 m/s for snow. */
  readonly impactThreshold?: number;
  /** Initiation threshold divided by sustaining threshold. Default 1.25. */
  readonly initiationRatio?: number;
  /** Effective horizontal grain-bed restitution. Default 0.35. */
  readonly restitution?: number;
  /** Splash multiplication in the saturation-length law. Default 0.2. */
  readonly multiplication?: number;
  /** Depositional time in subthreshold wind, seconds. Defaults to drag-deceleration length / grainSpeed. */
  readonly settlingTime?: number;
  /** Loose depth above bedrock, metres. Default 0.1. */
  readonly mobileDepth?: Scalars;
  /** Exposed erodible share from 0 (covered) to 1 (bare). Default 1. */
  readonly erodibility?: Scalars;
  /** Initial airborne saltation mass per unit bed area, kg/m². Default zero. */
  readonly initialSaltation?: Scalars;
  /** Mineral dust emission per transport length, m^-1. Defaults to 0.001 for sand and zero for snow. */
  readonly dustEfficiency?: number;
  /** Rise/run at repose. Defaults to tan(30°). */
  readonly repose?: number;
  /** Avalanching relaxation time, seconds. Default 0.25. Zero disables avalanching. */
  readonly avalancheTime?: number;
  /** Jackson–Hunt stress multiplier A. Defaults to 3.2. Zero takes wind stress as supplied. */
  readonly hillStrength?: number;
  /** Ratio B of the in-phase slope to Hilbert term in the positive-wind shear correction. Default 0.25. */
  readonly hillSlope?: number;
  /** Horizontal integration reach for topographic stress, metres. Default 20. */
  readonly hillFetch?: number;
  /** Open edges which export moving grains. All sides are closed by default. */
  readonly open?: Readonly<Partial<Record<Side, boolean>>>;
}

/** A local saltation column and its direct surface effects. */
export interface AeolianSample {
  /** Vertically integrated mass of moving grains, kg/m². */
  readonly mass: number;
  /** Moving grain velocity in m/s on X and Z. */
  readonly velocity: readonly [number, number];
  /** Emitted fine dust, kg/(m² s). */
  readonly dust: number;
  /** Stress exerted on the near-bed wind by the moving grains, Pa on X and Z. */
  readonly drag: readonly [number, number];
}

/** Current stores and cumulative exports in kilograms. */
export interface AeolianBudget {
  readonly mobileBed: number;
  readonly moving: number;
  readonly outflow: number;
  readonly dust: number;
}

interface Kernel extends WebAssembly.Exports {
  aeolian_step(
    wind: number,
    controls: number,
    height: number,
    settings: number,
    mass: number,
    mobile: number,
    change: number,
    motion: number,
    dust: number,
    drag: number,
    budget: number,
    scratch: number,
    nx: number,
    nz: number,
    dx: number,
    dz: number,
    open: number,
    dt: number,
    worldDt: number,
  ): void;
}

interface State {
  readonly host: SolverHost;
  readonly kernel: Kernel;
  readonly nx: number;
  readonly nz: number;
  readonly n: number;
  readonly dx: number;
  readonly dz: number;
  readonly x0: number;
  readonly z0: number;
  readonly open: number;
  readonly wind?: Wind;
  readonly friction: readonly [number, number];
  readonly airDensity: number;
  readonly heightOfWind: number;
  readonly windToFriction: number;
  readonly cellSize: number;
  readonly change: BedChange;
  readonly lifted: Region;
  readonly mobile: Region;
  readonly motion: Region;
  readonly dust: Region;
  readonly drag: Region;
  readonly budget: Region;
  readonly height: Region;
  readonly air: Region;
  readonly constants: Region;
  readonly settings: Region;
  readonly workingChange: Region;
  readonly scratch: Region;
  readonly cell: Region;
  readonly cover: Region;
}

function checked(name: string, value: number, min: number, max = Infinity): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`Invalid aeolian ${name}; pass a finite value from ${min} to ${max} in the stated units.`);
  return value;
}

function fill(out: Float64Array, value: Scalars, name: string, max = Infinity): void {
  if (typeof value === 'number') {
    out.fill(checked(name, value, 0, max));
    return;
  }
  if (value.length !== out.length)
    throw new RangeError(`Invalid aeolian ${name} length; supply one value or ${out.length} x-fast vertices.`);
  for (let i = 0; i < out.length; i++) out[i] = checked(name, value[i]!, 0, max);
}

function words(host: SolverHost, region: Region): Float64Array {
  return regionWords(host.memory, region) as Float64Array;
}

function vertexField(name: string, quantity: string, unit: string): FieldDescriptor {
  return { name, quantity, unit, kind: 'uniformGrid', centring: 'vertex' };
}

async function read(file: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (file.protocol === 'file:') {
    const node = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ node);
    file.search = '';
    return WebAssembly.compile(await readFile(file, { signal }));
  }
  const response = await fetch(file, { signal });
  if (!response.ok)
    throw new MargoError('failed', `Aeolian kernel HTTP ${response.status}; serve the matching aeolian Wasm file.`);
  return WebAssembly.compile(await response.arrayBuffer());
}

function cellMatches(port: Port, cell: Cell): boolean {
  return port.cell.every((value, index) => value === cell[index]);
}

/** Finite-volume saltation, dust emission, hillslope avalanching and wind stress on an evolving bed. */
export class AeolianTransport implements Solver<AeolianParams> {
  /** Layout-1 f64 vertex triples [mass, velocityX, velocityZ]. */
  readonly motionField: FieldDescriptor;
  /** Layout-1 f64 scalar dust emission in kg/(m² s) at each vertex. */
  readonly dustField: FieldDescriptor;
  /** Layout-1 f64 two-word stress exerted on the wind, in Pa on X and Z. */
  readonly windDragField: FieldDescriptor;
  private readonly id: string;
  private readonly friction?: FieldDescriptor;
  private readonly erodible?: FieldDescriptor;
  private state?: State;
  private readonly airSample: FlowSample = { velocity: [0, 0, 0], temperature: 0, density: 0 };

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    options: AeolianLoadOptions,
  ) {
    this.id = options.id ?? 'aeolian';
    const friction = options.frictionField;
    const erodible = options.erodibleField;
    if (friction && (friction.centring !== 'vertex' || friction.unit !== 'm/s'))
      throw new RangeError('Invalid aeolian friction field; bind vertex friction velocities in m/s.');
    if (erodible && (erodible.centring !== 'vertex' || erodible.unit !== '1'))
      throw new RangeError('Invalid aeolian erodibility field; bind dimensionless vertex shares from zero to one.');
    this.friction = friction && { ...friction };
    this.erodible = erodible && { ...erodible };
    this.motionField = vertexField(this.id + ':motion', 'saltation', 'kg/m^2');
    this.dustField = vertexField(this.id + ':dust', 'massFlux', 'kg/(m^2 s)');
    this.windDragField = vertexField(this.id + ':windDrag', 'stress', 'Pa');
  }

  /** Lazily load the native implementation with the world memory variants this host can use. */
  static async load(options: AeolianLoadOptions = {}): Promise<AeolianTransport> {
    const { signal } = options;
    const [plain, shared] = await Promise.all([
      read(new URL(/* @vite-ignore */ './aeolian-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? read(new URL(/* @vite-ignore */ './aeolian-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    return new AeolianTransport(plain, shared, options);
  }

  describe(): SolverDescription {
    const fields: FieldUse[] = [
      { field: BED_FIELD, access: 'read' },
      { field: BED_CHANGE_FIELD, access: 'accumulate' },
      { field: this.motionField, access: 'write' },
      { field: this.dustField, access: 'write' },
      { field: this.windDragField, access: 'write' },
    ];
    if (this.friction) fields.push({ field: this.friction, access: 'read' });
    if (this.erodible) fields.push({ field: this.erodible, access: 'read' });
    return { id: this.id, fields, rate: 0, stableRate: () => 0 };
  }

  init(host: SolverHost, params: AeolianParams): void {
    const grid = params?.grid;
    if (!grid) throw new RangeError('Aeolian transport needs a grid; pass the TerrainBed grid in metres.');
    const change = new BedChange(host, grid, 'aeolian-bed-change');
    const n = change.area.length;
    const nx = grid.columns + 1;
    const nz = grid.rows + 1;
    const dx = checked('column spacing', grid.width / grid.columns, Number.MIN_VALUE);
    const dz = checked('row spacing', grid.depth / grid.rows, Number.MIN_VALUE);
    const g = checked('gravity', gravityMagnitude(host.gravity), Number.MIN_VALUE);
    const material = params.material ?? 'sand';
    if (material !== 'sand' && material !== 'snow')
      throw new RangeError('Unknown aeolian material; choose sand or snow.');
    const snow = material === 'snow';
    const rho = checked('grain density', params.grainDensity ?? (snow ? 917 : 2650), Number.MIN_VALUE);
    const bulk = checked('bulk density', params.bulkDensity ?? (snow ? 300 : 1590), Number.MIN_VALUE, rho);
    const airDensity = checked('air density', params.airDensity ?? 1.225, 0);
    const size = checked('diameter', params.diameter ?? (snow ? 0.0002 : 0.00025), Number.MIN_VALUE);
    const threshold =
      params.impactThreshold === undefined
        ? snow
          ? 0.2
          : 0
        : checked('impact threshold', params.impactThreshold, Number.MIN_VALUE);
    const grainSpeed = checked('grain speed', params.grainSpeed ?? (snow ? 2.8 * threshold : 1.5), Number.MIN_VALUE);
    const heightOfWind = checked('reference height', params.referenceHeight ?? 10, Number.MIN_VALUE);
    const roughness = checked('roughness', params.roughness ?? 1e-4, Number.MIN_VALUE, heightOfWind);
    if (roughness === heightOfWind)
      throw new RangeError('Invalid aeolian roughness; choose a roughness height below the wind sampling height.');
    const cellSize = checked('cell size', params.cellSize ?? 4096, 1);
    const aperture = params.open;
    const open =
      (aperture?.minX ? 1 : 0) | (aperture?.maxX ? 2 : 0) | (aperture?.minZ ? 4 : 0) | (aperture?.maxZ ? 8 : 0);
    const friction = params.frictionVelocity ?? [0, 0];
    const settings = [
      g,
      rho,
      bulk,
      size,
      checked('restitution', params.restitution ?? 0.35, Number.MIN_VALUE, 1),
      checked('splash multiplier', params.multiplication ?? 0.2, Number.MIN_VALUE),
      grainSpeed,
      threshold,
      checked('initiation ratio', params.initiationRatio ?? 1.25, 1),
      checked('settling time', params.settlingTime ?? (4 * size * rho) / (9 * 1.225 * grainSpeed), Number.MIN_VALUE),
      checked('dust efficiency', params.dustEfficiency ?? (snow ? 0 : 0.001), 0),
      checked('repose', params.repose ?? 1 / Math.sqrt(3), 0),
      checked('avalanche time', params.avalancheTime ?? 0.25, 0),
      checked('hill strength', params.hillStrength ?? 3.2, 0),
      checked('hill slope', params.hillSlope ?? 0.25, 0),
      checked('hill fetch', params.hillFetch ?? 20, 0),
      snow ? 1 : 0,
    ];
    const shared =
      isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]';
    const module = shared ? this.shared : this.plain;
    if (!module)
      throw new MargoError('unsupported', 'Shared aeolian Wasm is unavailable; use plain world memory on this host.');
    const stack = host.allocate('aeolian-stack', STACK_BYTES + 8, 'u8', LAYOUT);
    const kernel = new WebAssembly.Instance(module, { env: { memory: host.memory } }).exports as Kernel;
    const pointer = kernel.__stack_pointer;
    const end = kernel.__data_end;
    if (!(pointer instanceof WebAssembly.Global) || !(end instanceof WebAssembly.Global) || end.value !== 0)
      throw new MargoError('failed', 'Invalid aeolian Wasm layout; rebuild the slot-free aeolian kernels.');
    pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
    const allocate = (name: string, count: number): Region =>
      host.allocate('aeolian-' + name, count * BYTES, 'f64', LAYOUT);
    const s: State = {
      host,
      kernel,
      n,
      nx,
      nz,
      dx,
      dz,
      open,
      change,
      x0: grid.centre[0] - grid.width * 0.5,
      z0: grid.centre[1] - grid.depth * 0.5,
      wind: params.wind,
      friction: [checked('friction X', friction[0], -Infinity), checked('friction Z', friction[1], -Infinity)],
      airDensity,
      heightOfWind,
      windToFriction: 0.4 / ln(heightOfWind / roughness),
      cellSize,
      lifted: allocate('moving-column', n),
      mobile: allocate('mobile-bed', n),
      motion: allocate('motion', 3 * n),
      dust: allocate('dust', n),
      drag: allocate('wind-drag', 2 * n),
      budget: allocate('budget', 2),
      height: allocate('bed-input', n),
      air: allocate('air-input', 3 * n),
      constants: allocate('area-exposure', 2 * n),
      settings: allocate('settings', settings.length),
      workingChange: allocate('transfer', n),
      scratch: allocate('scratch', 9 * n),
      cell: allocate('origin-and-revision', 4),
      cover: allocate('base-exposure', n),
    };
    const area = words(host, s.constants);
    const mobile = words(host, s.mobile);
    fill(mobile, params.mobileDepth ?? 0.1, 'mobile depth');
    fill(words(host, s.cover), params.erodibility ?? 1, 'erodibility', 1);
    const lifted = words(host, s.lifted);
    fill(lifted, params.initialSaltation ?? 0, 'initial saltation');
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const i = x + z * nx;
        area[i] = change.area[z + x * nz]!;
        mobile[i]! *= area[i]! * bulk;
      }
    const motion = words(host, s.motion);
    for (let i = 0; i < n; i++) motion[3 * i] = lifted[i]!;
    words(host, s.settings).set(settings);
    this.state = s;
  }

  importPorts(): void {
    // The scheduler supplies the bed and held air/exposure fields through StepContext.
  }

  step(context: StepContext, dt: number): void {
    const s = this.requireState();
    const { host, n, nx, nz } = s;
    const bed = context.inputs.get(BED_FIELD.name);
    if (!bed) {
      s.change.clear();
      return;
    }
    if (
      !cellMatches(bed, context.cell) ||
      bed.region.type !== 'f32' ||
      bed.region.layout !== BED_LAYOUT ||
      bed.region.byteLength !== n * 4
    )
      throw new RangeError('Invalid aeolian bed port; give the solver a matching TerrainBed in the same world cell.');
    const bedWords = regionWords(host.memory, bed.region);
    const height = words(host, s.height);
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) height[x + z * nx] = bedWords[z + x * nz]!;
    const exposure = words(host, s.constants).subarray(n);
    exposure.set(words(host, s.cover));
    const ground = this.erodible && context.inputs.get(this.erodible.name);
    if (ground) {
      const e = this.vertices(ground, context.cell, n, 'exposure');
      for (let i = 0; i < n; i++) exposure[i]! *= checked('surface share', e[i]!, 0, 1);
    }
    const friction = this.friction && context.inputs.get(this.friction.name);
    const forcing = friction && this.vertices(friction, context.cell, 3 * n, 'friction velocity');
    const input = words(host, s.air);
    const wind = s.wind;
    const dX = wind ? (context.cell[0] - wind.cell[0]) * s.cellSize : 0;
    const dY = wind ? (context.cell[1] - wind.cell[1]) * s.cellSize : 0;
    const dZ = wind ? (context.cell[2] - wind.cell[2]) * s.cellSize : 0;
    for (let i = 0; i < n; i++) {
      let [u, v] = s.friction;
      let rho = s.airDensity;
      if (forcing) {
        u = forcing[3 * i]!;
        v = forcing[3 * i + 1]!;
        rho = forcing[3 * i + 2]!;
      } else if (wind) {
        const sample = wind.sample(
          s.x0 + (i % nx) * s.dx + dX,
          height[i]! + s.heightOfWind + dY,
          s.z0 + Math.floor(i / nx) * s.dz + dZ,
          context.tick * dt,
          this.airSample,
        );
        u = s.windToFriction * sample.velocity[0];
        v = s.windToFriction * sample.velocity[2];
        rho = sample.density;
      }
      input[i] = checked('friction X', u, -Infinity);
      input[n + i] = checked('friction Z', v, -Infinity);
      input[2 * n + i] = checked('air density', rho, 0);
    }
    s.kernel.aeolian_step(
      s.air.byteOffset,
      s.constants.byteOffset,
      s.height.byteOffset,
      s.settings.byteOffset,
      s.lifted.byteOffset,
      s.mobile.byteOffset,
      s.workingChange.byteOffset,
      s.motion.byteOffset,
      s.dust.byteOffset,
      s.drag.byteOffset,
      s.budget.byteOffset,
      s.scratch.byteOffset,
      nx,
      nz,
      s.dx,
      s.dz,
      s.open,
      dt,
      dt,
    );
    const changes = words(host, s.workingChange);
    const deltas = s.change.deltas;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) deltas[z + x * nz] = changes[x + z * nx]!;
    const origin = words(host, s.cell);
    origin.set(context.cell);
    origin[3] = context.tick + 1;
  }

  private vertices(port: Port, cell: Cell, count: number, label: string) {
    const r = port.region;
    if (
      !cellMatches(port, cell) ||
      r.layout !== LAYOUT ||
      (r.type !== 'f32' && r.type !== 'f64') ||
      r.byteLength !== count * (r.type === 'f32' ? 4 : BYTES)
    )
      throw new RangeError(
        `Invalid aeolian ${label} port; supply layout-1 vertex data on the same grid and world cell.`,
      );
    return regionWords(this.requireState().host.memory, r);
  }

  exportPorts(tick: number): readonly Port[] {
    const s = this.requireState();
    const [x, y, z] = words(s.host, s.cell);
    const cell: Cell = [x!, y!, z!];
    return [
      s.change.port(tick, cell),
      { field: this.motionField.name, region: s.motion, tick, cell },
      { field: this.dustField.name, region: s.dust, tick, cell },
      { field: this.windDragField.name, region: s.drag, tick, cell },
    ];
  }

  stateRegions(): readonly Region[] {
    const s = this.requireState();
    return [s.lifted, s.mobile, s.motion, s.dust, s.drag, s.budget, s.change.state, s.settings, s.cover, s.cell];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Revision of the sampled transport after each completed world step. */
  get revision(): number {
    const s = this.requireState();
    return words(s.host, s.cell)[3]!;
  }

  /** Horizontal limits in the bed's cell in metres, [minX, minZ, maxX, maxZ]. */
  get bounds(): readonly [number, number, number, number] {
    const s = this.requireState();
    return [s.x0, s.z0, s.x0 + (s.nx - 1) * s.dx, s.z0 + (s.nz - 1) * s.dz];
  }

  /** The transport at an integer X-column and Z-row. */
  read(column: number, row: number): AeolianSample {
    const s = this.requireState();
    if (!Number.isInteger(column) || !Number.isInteger(row) || column < 0 || column >= s.nx || row < 0 || row >= s.nz)
      throw new RangeError('Invalid aeolian vertex; pass an integer column and row inside the bed grid.');
    const i = column + s.nx * row;
    const motion = words(s.host, s.motion);
    const stress = words(s.host, s.drag);
    return {
      mass: motion[3 * i]!,
      velocity: [motion[3 * i + 1]!, motion[3 * i + 2]!],
      dust: words(s.host, s.dust)[i]!,
      drag: [stress[2 * i]!, stress[2 * i + 1]!],
    };
  }

  /** Nearest resolved transport column at (x, z) metres in the bed's cell, or undefined outside the bed. */
  sample(x: number, z: number): AeolianSample | undefined {
    const s = this.requireState();
    const u = (x - s.x0) / s.dx;
    const v = (z - s.z0) / s.dz;
    return u >= 0 && u <= s.nx - 1 && v >= 0 && v <= s.nz - 1 ? this.read(Math.round(u), Math.round(v)) : undefined;
  }

  /** Current mass and cumulative dust and open-boundary losses. */
  get budget(): AeolianBudget {
    const s = this.requireState();
    const volume = words(s.host, s.constants);
    const moving = words(s.host, s.lifted);
    const mobile = words(s.host, s.mobile);
    let airMass = 0;
    let bedMass = 0;
    for (let i = 0; i < s.n; i++) {
      airMass += moving[i]! * volume[i]!;
      bedMass += mobile[i]!;
    }
    const [outflow, dust] = words(s.host, s.budget);
    return { mobileBed: bedMass, moving: airMass, outflow: outflow!, dust: dust! };
  }

  private requireState(): State {
    if (!this.state)
      throw new MargoError('state', 'Aeolian transport is not attached; add it to a PhysicsWorld with the bed grid.');
    return this.state;
  }
}
