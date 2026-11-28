import { MargoError } from '@margoengine/math/errors';
import type { FlowSample, Wind } from '@margoengine/math/fields';
import { gravityMagnitude } from '@margoengine/math/gravity';
import { exp, ln } from '@margoengine/math/pinned';
import { type BedShape, BedChange, BED_CHANGE_FIELD, BED_FIELD, BED_LAYOUT } from '../earth/bed.js';
import type { NativePhasePool } from '../native-phase-pool.js';
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
const JOB_BYTES = 112;
const RECEIPT_WORDS = 7;
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
  /** Native participants, including the calling thread. Defaults to 1. */
  readonly threads?: number;
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
  /** Short splash hops for resolving impact ripples on a fine sand grid. Disabled when omitted. */
  readonly ripples?: {
    /** Mean length of low-energy splash hops, metres. */
    readonly meanHop: number;
    /** Cotangent of the incident angle of the saltating grains. Default 4. */
    readonly impactCotangent?: number;
    /** Mass ejected per second per kg of the moving population. Default grainSpeed / 0.3 m. */
    readonly ejectionsPerSecond?: number;
  };
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

/** Work performed by one partition during the last accepted step. */
export interface AeolianWorkerWork {
  readonly slopeRows: number;
  readonly forcingRows: number;
  readonly exchangeRows: number;
  readonly publishedRows: number;
  readonly forcingPairs: number;
  readonly exchangePairs: number;
}

/** Deterministic work counts from the last accepted step, including the caller's partition. */
export interface AeolianWorkCounts {
  readonly substeps: number;
  readonly workers: readonly AeolianWorkerWork[];
}

interface Kernel extends WebAssembly.Exports {
  aeolian_step(job: number): number;
  aeolian_thread_phase(job: number, stage: number, part: number, parts: number): number;
  aeolian_thread_plan(job: number, parts: number): number;
  aeolian_thread_route(job: number): number;
  aeolian_thread_finish(job: number): number;
}

interface TransportRegions {
  readonly lifted: Region;
  readonly mobile: Region;
  readonly motion: Region;
  readonly dust: Region;
  readonly drag: Region;
  readonly budget: Region;
}

interface State extends TransportRegions {
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
  readonly meanHop: number;
  readonly change: BedChange;
  readonly height: Region;
  readonly air: Region;
  readonly constants: Region;
  readonly settings: Region;
  readonly workingChange: Region;
  readonly scratch: Region;
  readonly cell: Region;
  readonly cover: Region;
  readonly candidate: TransportRegions;
  readonly job: Region;
  readonly receipts: Region;
}

function invalid(message: string): MargoError {
  return new MargoError('state', message);
}

function checked(name: string, value: number, min: number, max = Infinity): number {
  if (!Number.isFinite(value) || value < min || value > max)
    throw invalid(`Invalid aeolian ${name}; pass a finite value from ${min} to ${max} in the stated units.`);
  return value;
}

function fill(out: Float64Array, value: Scalars, name: string, max = Infinity): void {
  if (typeof value === 'number') {
    out.fill(checked(name, value, 0, max));
    return;
  }
  if (value?.length !== out.length)
    throw invalid(`Invalid aeolian ${name} length; supply one value or ${out.length} x-fast vertices.`);
  for (let i = 0; i < out.length; i++) out[i] = checked(name, value[i]!, 0, max);
}

function words(host: SolverHost, region: Region): Float64Array {
  return regionWords(host.memory, region) as Float64Array;
}

function vertexField(name: string, quantity: string, unit: string): FieldDescriptor {
  return { name, quantity, unit, kind: 'uniformGrid', centring: 'vertex' };
}

function stackTop(host: SolverHost, label: string): number {
  const region = host.allocate(label, STACK_BYTES + 8, 'u8', LAYOUT);
  return Math.floor((region.byteOffset + region.byteLength) / 16) * 16;
}

function validCell(cell: Cell, label: string): Cell {
  if (
    cell?.length !== 3 ||
    !Number.isSafeInteger(cell[0]) ||
    !Number.isSafeInteger(cell[1]) ||
    !Number.isSafeInteger(cell[2])
  )
    throw invalid(`Invalid aeolian ${label} cell; use three signed, safe integer cell coordinates.`);
  return cell;
}

function cellOffset(a: number, b: number, scale: number): number {
  const delta = a - b;
  if (!Number.isSafeInteger(delta) || !Number.isFinite(delta * scale))
    throw invalid('Aeolian wind and bed are too far apart; place the wind in a cell nearer the bed.');
  return delta * scale;
}

function nativeStatus(status: number): void {
  if (status === 0) return;
  if (status === 1)
    throw invalid(
      'Aeolian transport exceeds the numeric range; reduce forcing, material extremes or the step interval.',
    );
  if (status === 2)
    throw invalid('Aeolian transport cannot resolve this interval; reduce the step or use coarser bed cells.');
  throw new MargoError('failed', 'Invalid aeolian native job; rebuild and serve the matching kernels.');
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
  return port.cell?.length === 3 && port.cell[0] === cell[0] && port.cell[1] === cell[1] && port.cell[2] === cell[2];
}

function readable(memory: WebAssembly.Memory, region: Region, bytes: number): boolean {
  return (
    Number.isSafeInteger(region.byteOffset) &&
    region.byteOffset >= 0 &&
    region.byteOffset % bytes === 0 &&
    region.byteOffset + region.byteLength <= memory.buffer.byteLength
  );
}

function workCounts(receipts: Float64Array, substeps: number, n: number): AeolianWorkCounts {
  const workers: AeolianWorkerWork[] = [];
  let rows = 0;
  for (let at = 0; at < receipts.length; at += RECEIPT_WORDS) {
    const worker = {
      slopeRows: receipts[at + 1]!,
      forcingRows: receipts[at + 2]!,
      exchangeRows: receipts[at + 3]!,
      publishedRows: receipts[at + 4]!,
      forcingPairs: receipts[at + 5]!,
      exchangePairs: receipts[at + 6]!,
    };
    if (
      Object.values(worker).some((count) => !Number.isSafeInteger(count) || count < 0) ||
      worker.forcingRows !== worker.slopeRows ||
      worker.publishedRows !== worker.slopeRows ||
      worker.exchangeRows !== worker.slopeRows * substeps ||
      worker.forcingPairs * 2 > worker.forcingRows ||
      worker.exchangePairs * 2 > worker.exchangeRows
    )
      throw new MargoError('failed', 'Invalid aeolian work receipt; rebuild and serve the matching native kernels.');
    rows += worker.slopeRows;
    workers.push(worker);
  }
  if (substeps === 0 || rows !== n)
    throw new MargoError('failed', 'Aeolian work receipts missed grid vertices; rebuild the matching native kernels.');
  return { substeps, workers };
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
  private pool?: NativePhasePool;
  private work?: AeolianWorkCounts;
  private disposed = false;
  private readonly airSample: FlowSample = { velocity: [0, 0, 0], temperature: 0, density: 0 };

  private constructor(
    private readonly plain: WebAssembly.Module,
    private readonly shared: WebAssembly.Module | undefined,
    options: AeolianLoadOptions,
  ) {
    this.id = options.id ?? 'aeolian';
    if (typeof this.id !== 'string' || this.id.length === 0)
      throw invalid('Invalid aeolian solver ID; supply a nonempty field prefix.');
    const friction = options.frictionField;
    const erodible = options.erodibleField;
    if (friction && (friction.centring !== 'vertex' || friction.unit !== 'm/s' || !friction.name))
      throw invalid('Invalid aeolian friction field; bind named vertex friction velocities in m/s.');
    if (erodible && (erodible.centring !== 'vertex' || erodible.unit !== '1' || !erodible.name))
      throw invalid('Invalid aeolian erodibility field; bind named dimensionless vertex shares from zero to one.');
    this.friction = friction && { ...friction };
    this.erodible = erodible && { ...erodible };
    this.motionField = vertexField(this.id + ':motion', 'saltation', 'kg/m^2');
    this.dustField = vertexField(this.id + ':dust', 'massFlux', 'kg/(m^2 s)');
    this.windDragField = vertexField(this.id + ':windDrag', 'stress', 'Pa');
  }

  /** Lazily load the native implementation and, when requested, its shared-memory helpers. */
  static async load(options: AeolianLoadOptions = {}): Promise<AeolianTransport> {
    if (!options || typeof options !== 'object')
      throw invalid('Invalid aeolian load options; provide an options object or omit it.');
    const { signal, threads = 1 } = options;
    if (threads !== 1 && threads !== 2 && threads !== 4)
      throw invalid('Invalid aeolian worker count; use 1, 2 or 4 native participants.');
    const [plain, shared] = await Promise.all([
      read(new URL(/* @vite-ignore */ './aeolian-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? read(new URL(/* @vite-ignore */ './aeolian-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    const solver = new AeolianTransport(plain, shared, options);
    if (threads > 1) {
      if (!shared)
        throw new MargoError(
          'unsupported',
          'Aeolian helpers need shared memory; use a shared-memory host or threads: 1.',
        );
      const { createNativePhasePool } = await import('../native-phase-pool.js');
      solver.pool = await createNativePhasePool(threads, {
        subject: 'Aeolian',
        phaseExport: 'aeolian_thread_phase',
        phase: 'saltation',
        signal,
      });
    }
    return solver;
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
    if (this.disposed) throw new MargoError('disposed', 'Aeolian transport is disposed; load a new solver.');
    if (this.state && this.pool)
      throw new MargoError(
        'attached',
        'Aeolian helpers are already bound; load a new threaded solver for the other world.',
      );
    const grid = params?.grid;
    if (
      !grid ||
      !Number.isSafeInteger(grid.columns) ||
      !Number.isSafeInteger(grid.rows) ||
      grid.columns < 1 ||
      grid.rows < 1 ||
      grid.centre?.length !== 2 ||
      !Number.isFinite(grid.centre[0]) ||
      !Number.isFinite(grid.centre[1])
    )
      throw invalid('Invalid aeolian grid; pass the TerrainBed widths, positive whole cell counts and [x, z] centre.');
    const nx = grid.columns + 1;
    const nz = grid.rows + 1;
    const n = nx * nz;
    if (n * 9 * BYTES > 0xffff_ffff)
      throw invalid('Aeolian grid exceeds native storage; use fewer TerrainBed columns or rows.');
    const dx = checked('column spacing', grid.width / grid.columns, Number.MIN_VALUE);
    const dz = checked('row spacing', grid.depth / grid.rows, Number.MIN_VALUE);
    checked('cell triangle area', (dx * dz) / 6, Number.MIN_VALUE);
    const x0 = checked('minimum grid X', grid.centre[0] - grid.width * 0.5, -Infinity);
    const z0 = checked('minimum grid Z', grid.centre[1] - grid.depth * 0.5, -Infinity);
    const x1 = checked('maximum grid X', x0 + (nx - 1) * dx, -Infinity);
    const z1 = checked('maximum grid Z', z0 + (nz - 1) * dz, -Infinity);
    if (x1 - dx === x1 || x0 + dx === x0 || z1 - dz === z1 || z0 + dz === z0)
      throw invalid('Aeolian grid loses cell spacing at its centre; place it closer to the cell origin.');
    const g = checked('gravity', gravityMagnitude(host.gravity), Number.MIN_VALUE);
    const material = params.material ?? 'sand';
    if (material !== 'sand' && material !== 'snow') throw invalid('Unknown aeolian material; choose sand or snow.');
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
      throw invalid('Invalid aeolian roughness; choose a roughness height below the wind sampling height.');
    const ratio = heightOfWind / roughness;
    const profile = Number.isFinite(ratio) ? ln(ratio) : ln(heightOfWind) - ln(roughness);
    const windToFriction = checked('wind to friction conversion', 0.4 / profile, Number.MIN_VALUE);
    const cellSize = checked('cell size', params.cellSize ?? 4096, 1);
    const aperture = params.open;
    const open =
      (aperture?.minX ? 1 : 0) | (aperture?.maxX ? 2 : 0) | (aperture?.minZ ? 4 : 0) | (aperture?.maxZ ? 8 : 0);
    const friction = params.frictionVelocity ?? [0, 0];
    if (friction.length !== 2)
      throw invalid('Invalid aeolian friction velocity; give horizontal [X, Z] velocity in metres per second.');
    const prescribed: readonly [number, number] = [
      checked('friction X', friction[0], -Infinity),
      checked('friction Z', friction[1], -Infinity),
    ];
    if (params.wind) {
      if (typeof params.wind.sample !== 'function')
        throw invalid('Invalid aeolian wind; supply a Wind with a sample method and origin cell.');
      validCell(params.wind.cell, 'wind');
    }
    const ripples = !snow && params.ripples;
    const meanHop = ripples ? checked('mean ripple hop', ripples.meanHop, Number.MIN_VALUE) : 0;
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
      ripples ? checked('ripple ejection rate', ripples.ejectionsPerSecond ?? grainSpeed / 0.3, 0) : 0,
      ripples ? checked('ripple incident cotangent', ripples.impactCotangent ?? 4, 0) : 0,
    ];
    const shared =
      isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]';
    if (this.pool && !shared)
      throw new MargoError(
        'unsupported',
        'Aeolian helpers need shared world memory; use worldMemory(true) or threads: 1.',
      );
    const module = shared ? this.shared : this.plain;
    if (!module)
      throw new MargoError('unsupported', 'Shared aeolian Wasm is unavailable; use plain world memory on this host.');
    const cell = validCell(host.cell, 'initial bed');
    const change = new BedChange(host, grid, 'aeolian-bed-change');
    const top = stackTop(host, 'aeolian-stack');
    const kernel = new WebAssembly.Instance(module, { env: { memory: host.memory } }).exports as Kernel;
    const pointer = kernel.__stack_pointer;
    const end = kernel.__data_end;
    if (
      !(pointer instanceof WebAssembly.Global) ||
      !(end instanceof WebAssembly.Global) ||
      end.value !== 0 ||
      typeof kernel.aeolian_step !== 'function' ||
      typeof kernel.aeolian_thread_phase !== 'function'
    )
      throw new MargoError('failed', 'Invalid aeolian Wasm layout; rebuild the slot-free aeolian kernels.');
    pointer.value = top;
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
      x0,
      z0,
      wind: params.wind,
      friction: prescribed,
      airDensity,
      heightOfWind,
      windToFriction,
      cellSize,
      meanHop,
      lifted: allocate('moving-column', n),
      mobile: allocate('mobile-bed', n),
      motion: allocate('motion', 3 * n),
      dust: allocate('dust', n),
      drag: allocate('wind-drag', 2 * n),
      budget: allocate('budget', 2),
      height: allocate('bed-input', n),
      air: allocate('air-input', 4 * n),
      constants: allocate('area-exposure', 2 * n),
      settings: allocate('settings', settings.length),
      workingChange: allocate('transfer', n),
      scratch: allocate('scratch', 9 * n),
      cell: allocate('origin-and-revision', 4),
      cover: allocate('base-exposure', n),
      candidate: {
        lifted: allocate('candidate-moving-column', n),
        mobile: allocate('candidate-mobile-bed', n),
        motion: allocate('candidate-motion', 3 * n),
        dust: allocate('candidate-dust', n),
        drag: allocate('candidate-wind-drag', 2 * n),
        budget: allocate('candidate-budget', 2),
      },
      job: host.allocate('aeolian-native-job', JOB_BYTES, 'u8', LAYOUT),
      receipts: allocate('worker-receipts', RECEIPT_WORDS * (this.pool?.count ?? 1)),
    };
    const area = words(host, s.constants);
    const mobile = words(host, s.mobile);
    fill(mobile, params.mobileDepth ?? 0.1, 'mobile depth');
    fill(words(host, s.cover), params.erodibility ?? 1, 'erodibility', 1);
    const lifted = words(host, s.lifted);
    fill(lifted, params.initialSaltation ?? 0, 'initial saltation');
    let bedMass = 0;
    let airMass = 0;
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const i = x + z * nx;
        area[i] = change.area[z + x * nz]!;
        mobile[i]! *= area[i]! * bulk;
        bedMass += mobile[i]!;
        airMass += lifted[i]! * area[i]!;
      }
    if (!Number.isFinite(bedMass + airMass))
      throw invalid(
        'Aeolian initial mass exceeds the numeric range; reduce bed area, loose depth or the initial saltation mass.',
      );
    const motion = words(host, s.motion);
    for (let i = 0; i < n; i++) motion[3 * i] = lifted[i]!;
    words(host, s.settings).set(settings);
    words(host, s.cell).set(cell);
    const pool = this.pool;
    if (pool) {
      const control = host.allocate('aeolian-workers', pool.controlWords * 4, 'i32', LAYOUT);
      const stackTops = Array.from({ length: pool.count - 1 }, (_, i) =>
        stackTop(host, `aeolian-worker-stack-${i + 1}`),
      );
      pool.init({ module, memory: host.memory, control: control.byteOffset, job: s.job.byteOffset, stackTops });
    }
    this.work = undefined;
    this.state = s;
  }

  importPorts(): void {
    // The scheduler supplies the bed and held air/exposure fields through StepContext.
  }

  step(context: StepContext, dt: number): void {
    const s = this.requireState();
    const { host, n, nx, nz } = s;
    const cell = validCell(context.cell, 'step');
    const tick = context.tick;
    if (!Number.isSafeInteger(tick + 1) || !Number.isInteger(tick) || tick < 0 || !(dt > 0 && Number.isFinite(dt)))
      throw invalid('Invalid aeolian clock; step with a valid world tick and finite, positive interval.');
    const time = tick * dt;
    if (!Number.isFinite(time) || !((tick + 1) * dt > time) || !Number.isFinite((tick + 1) * dt))
      throw invalid('The aeolian clock cannot advance; use a representable world time and step interval.');
    const bed = context.inputs.get(BED_FIELD.name);
    if (!bed) {
      s.change.clear();
      return;
    }
    if (
      !cellMatches(bed, cell) ||
      bed.region.type !== 'f32' ||
      bed.region.layout !== BED_LAYOUT ||
      bed.region.byteLength !== n * 4 ||
      !readable(host.memory, bed.region, 4)
    )
      throw invalid('Invalid aeolian bed port; give the solver a matching TerrainBed in the same world cell.');
    const bedWords = regionWords(host.memory, bed.region);
    const height = words(host, s.height);
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++)
        height[x + z * nx] = checked('TerrainBed elevation', bedWords[z + x * nz]!, -Infinity);
    const exposure = words(host, s.constants).subarray(n);
    exposure.set(words(host, s.cover));
    const ground = this.erodible && context.inputs.get(this.erodible.name);
    if (ground) {
      const e = this.vertices(ground, cell, n, 'exposure');
      for (let i = 0; i < n; i++) exposure[i]! *= checked('surface share', e[i]!, 0, 1);
    }
    const friction = this.friction && context.inputs.get(this.friction.name);
    const forcing = friction && this.vertices(friction, cell, 3 * n, 'friction velocity');
    const input = words(host, s.air);
    const wind = !forcing && s.wind;
    const windCell = wind && validCell(wind.cell, 'wind');
    const dX = windCell ? cellOffset(cell[0], windCell[0], s.cellSize) : 0;
    const dY = windCell ? cellOffset(cell[1], windCell[1], s.cellSize) : 0;
    const dZ = windCell ? cellOffset(cell[2], windCell[2], s.cellSize) : 0;
    for (let i = 0; i < n; i++) {
      let [u, v] = s.friction;
      let rho = s.airDensity;
      if (forcing) {
        u = forcing[3 * i]!;
        v = forcing[3 * i + 1]!;
        rho = forcing[3 * i + 2]!;
      } else if (wind) {
        const sample = wind.sample(
          checked('wind sample X', s.x0 + (i % nx) * s.dx + dX, -Infinity),
          checked('wind sample Y', height[i]! + s.heightOfWind + dY, -Infinity),
          checked('wind sample Z', s.z0 + Math.floor(i / nx) * s.dz + dZ, -Infinity),
          time,
          this.airSample,
        );
        if (!sample || sample.velocity?.length !== 3)
          throw invalid('Invalid aeolian wind sample; return a three-component velocity and air density.');
        u = s.windToFriction * sample.velocity[0];
        v = s.windToFriction * sample.velocity[2];
        rho = sample.density;
      }
      input[i] = checked('friction X', u, -Infinity);
      input[n + i] = checked('friction Z', v, -Infinity);
      input[2 * n + i] = checked('air density', rho, 0);
      if (s.meanHop > 0) {
        const magnitude2 = u * u + v * v;
        const scale = Math.max(Math.abs(u), Math.abs(v));
        const crossing = Math.max(Math.abs(u) / s.dx, Math.abs(v) / s.dz);
        let step = Infinity;
        if (scale > 0) {
          if (magnitude2 > 0 && Number.isFinite(magnitude2) && crossing > 0 && Number.isFinite(crossing)) {
            step = Math.sqrt(magnitude2) / crossing;
          } else {
            const a = u / scale;
            const b = v / scale;
            step = Math.sqrt(a * a + b * b) / Math.max(Math.abs(a) / s.dx, Math.abs(b) / s.dz);
          }
        }
        input[3 * n + i] = exp((-0.5 * step) / s.meanHop);
      }
    }

    const work = this.integrate(s, dt);
    for (const field of ['lifted', 'mobile', 'motion', 'dust', 'drag', 'budget'] as const)
      words(host, s[field]).set(words(host, s.candidate[field]));
    const changes = words(host, s.workingChange);
    const deltas = s.change.deltas;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) deltas[z + x * nz] = changes[x + z * nx]!;
    const origin = words(host, s.cell);
    origin.set(cell);
    origin[3] = tick + 1;
    this.work = work;
  }

  private integrate(s: State, dt: number): AeolianWorkCounts {
    const { host, candidate, kernel } = s;
    for (const field of ['lifted', 'mobile', 'budget'] as const)
      words(host, candidate[field]).set(words(host, s[field]));
    const entries = [
      s.air.byteOffset,
      s.constants.byteOffset,
      s.height.byteOffset,
      s.settings.byteOffset,
      candidate.lifted.byteOffset,
      candidate.mobile.byteOffset,
      s.workingChange.byteOffset,
      candidate.motion.byteOffset,
      candidate.dust.byteOffset,
      candidate.drag.byteOffset,
      candidate.budget.byteOffset,
      s.scratch.byteOffset,
      s.receipts.byteOffset,
      s.nx,
      s.nz,
      s.open,
      0, // Number of intervals, filled by the native CFL plan.
      0,
    ];
    const job = s.job.byteOffset;
    const view = new DataView(host.memory.buffer, job, JOB_BYTES);
    for (let i = 0; i < entries.length; i++) view.setUint32(i * 4, entries[i]!, true);
    view.setFloat64(72, s.dx, true);
    view.setFloat64(80, s.dz, true);
    view.setFloat64(88, dt, true);
    view.setFloat64(96, dt, true);
    view.setFloat64(104, 0, true);
    const pool = this.pool;
    if (pool) {
      const parts = pool.count;
      const phase = (stage: number) =>
        nativeStatus(pool.phase(stage, () => kernel.aeolian_thread_phase(job, stage, 0, parts)));
      phase(0);
      phase(1);
      nativeStatus(kernel.aeolian_thread_plan(job, parts));
      const substeps = view.getUint32(64, true);
      for (let k = 0; k < substeps; k++) {
        phase(2);
        nativeStatus(kernel.aeolian_thread_route(job));
      }
      phase(3);
      nativeStatus(kernel.aeolian_thread_finish(job));
    } else {
      nativeStatus(kernel.aeolian_step(job));
    }
    return workCounts(words(host, s.receipts), view.getUint32(64, true), s.n);
  }

  private vertices(port: Port, cell: Cell, count: number, label: string) {
    const r = port.region;
    const memory = this.requireState().host.memory;
    const bytes = r.type === 'f32' ? 4 : BYTES;
    if (
      !cellMatches(port, cell) ||
      r.layout !== LAYOUT ||
      (r.type !== 'f32' && r.type !== 'f64') ||
      r.byteLength !== count * bytes ||
      !readable(memory, r, bytes)
    )
      throw invalid(`Invalid aeolian ${label} port; supply layout-1 vertex data on the same grid and world cell.`);
    return regionWords(memory, r);
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
      throw invalid('Invalid aeolian vertex; pass an integer column and row inside the bed grid.');
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
    if (!Number.isFinite(x) || !Number.isFinite(z))
      throw invalid('Invalid aeolian sample; give finite X and Z metres within the bed cell.');
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

  /** Returns native work for the latest accepted step computed by this instance. */
  workCounts(): AeolianWorkCounts | undefined {
    this.requireState();
    return this.work;
  }

  /** Releases optional native helpers. Dispose after the world finishes stepping this solver. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pool?.close();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  private requireState(): State {
    if (this.disposed) throw new MargoError('disposed', 'Aeolian transport is disposed; load a new solver.');
    if (!this.state)
      throw new MargoError('state', 'Aeolian transport is not attached; add it to a PhysicsWorld with the bed grid.');
    return this.state;
  }
}
