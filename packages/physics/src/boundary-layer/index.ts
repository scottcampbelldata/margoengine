import { MargoError } from '@margoengine/math/errors';
import type { FlowSample, Wind } from '@margoengine/math/fields';
import type { NativePhasePool } from '../native-phase-pool.js';
import { DYNAMIC_BASE, isShared, MAX_MEMORY_PAGES } from '../world/memory.js';
import type {
  Cell,
  FieldDescriptor,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import {
  type BoundaryLayerBuilds,
  type BoundaryLayerKernel,
  bindWind,
  loadBoundaryLayerBuilds,
  windStackTop,
} from './kernel.js';

/** Field layout of one boundary-layer sample. Rows contain vx, vy, vz, density and temperature in SI units. */
export const BOUNDARY_LAYER_LAYOUT = 1;
/** Number of f64 words in a published wind sample row. */
export const BOUNDARY_LAYER_WORDS = 5;

type Vector = readonly [number, number, number];

const ORIGIN: Cell = [0, 0, 0];
const F64 = Float64Array.BYTES_PER_ELEMENT;
const U32 = Uint32Array.BYTES_PER_ELEMENT;
const JOB_HEADER_WORDS = 12;
const JOB_HEADER_BYTES = JOB_HEADER_WORDS * U32;
const JOB_VALUE_WORDS = 12;
const JOB_BYTES = JOB_HEADER_BYTES + JOB_VALUE_WORDS * F64;
const JOB_TIME = 6;
const RECEIPT_WORDS = 3;
const MAX_THREADS = 64;

/** Frozen Mann box values in its along-wind, cross-wind and vertical coordinates. */
export interface BoundaryLayerTurbulence {
  /** Number of samples along the three box axes. */
  readonly cells: Vector;
  /** Physical box lengths in metres. */
  readonly size: Vector;
  /** Along-wind fluctuation in m/s, with the along-wind index varying fastest. */
  readonly u: Float64Array;
  /** Horizontal cross-wind fluctuation in m/s, in the same layout. */
  readonly v: Float64Array;
  /** Vertical fluctuation in m/s, in the same layout. */
  readonly w: Float64Array;
}

/** Resolved atmospheric parameters, available as Weather BoundaryLayerWind.profile. */
export interface BoundaryLayerGridProfile {
  /** Aerodynamic roughness height z0 above the local ground, in metres. */
  readonly roughness: number;
  /** Signed Monin-Obukhov length L in metres. Use Infinity for neutral air. */
  readonly obukhovLength: number;
  /** The velocity scale u* divided by the von Karman constant, in m/s. */
  readonly meanScale: number;
  /** Integrated momentum correction at z0/L in unstable air. Use zero for neutral and stable air. */
  readonly psiAtRoughness: number;
  /** Local ground height in metres from the origin cell. */
  readonly ground: number;
  /** Ground altitude above sea level in metres. */
  readonly altitude: number;
  /** Temperature in kelvin at sea level for the standard atmosphere. */
  readonly seaLevelTemperature: number;
  /** Unit vector in the horizontal plane, [x, z]. */
  readonly along: readonly [number, number];
  /** Optional frozen gust field. Its planes are copied into world memory at attachment. */
  readonly turbulence?: BoundaryLayerTurbulence;
}

/** Grid of registry samples in the solver's origin cell. */
export interface BoundaryLayerGrid {
  /** Number of samples along X, Y and Z. */
  readonly cells: Vector;
  /** Position of the first sample in metres, with no half-spacing offset. */
  readonly origin: Vector;
  /** Positive step between samples in metres, along X, Y and Z. */
  readonly spacing: Vector;
}

/** Boundary-layer field and its regular registry grid. */
export interface BoundaryLayerOptions {
  /** Resolved surface-layer profile and optional Mann fluctuations. */
  readonly profile: BoundaryLayerGridProfile;
  /** Grid containing the world-local points to publish. */
  readonly grid: BoundaryLayerGrid;
}

/** Options for loading the optional native boundary-layer solver. */
export interface BoundaryLayerLoadOptions {
  /** Registry ID. Defaults to 'boundary-layer'. */
  readonly id?: string;
  /** Native threads including the caller. Defaults to one. More threads need shared world memory. */
  readonly threads?: number;
  /** Cancels the Wasm or worker setup. */
  readonly signal?: AbortSignal;
}

/** Actual work of one partition of the accepted grid sampling tick. */
export interface BoundaryLayerWorkerWork {
  /** Number of wind samples produced. */
  readonly rows: number;
  /** Number of rows written as SIMD pairs within this partition. */
  readonly pairedRows: number;
  /** Number of rows evaluated inside the finite Mann height envelope. */
  readonly turbulentRows: number;
}

/** Native grid work that contributed to the last successful tick. */
export interface BoundaryLayerWorkCounts extends BoundaryLayerWorkerWork {
  /** Number of partitions including the caller. */
  readonly threads: number;
  /** Work per partition in deterministic index order. */
  readonly workers: readonly BoundaryLayerWorkerWork[];
}

interface State {
  readonly host: SolverHost;
  readonly kernel: BoundaryLayerKernel;
  readonly grid: BoundaryLayerGrid;
  readonly n: number;
  readonly output: Region;
  readonly candidate: Region;
  readonly clock: Region;
  readonly job: Region;
  readonly oneJob: Region;
  readonly oneSample: Region;
  readonly receipts: Region;
  readonly frameProfile: Region;
  readonly regions: readonly Region[];
  readonly accepted: Uint32Array;
}

function floats(host: SolverHost, region: Region): Float64Array {
  return new Float64Array(host.memory.buffer, region.byteOffset, region.byteLength / F64);
}

function whole(vector: Vector, label: string): Vector {
  if (
    !Array.isArray(vector) ||
    vector.length !== 3 ||
    !vector.every((n) => Number.isInteger(n) && n > 0 && n <= 0xffffffff)
  )
    throw new MargoError('state', `Invalid ${label}. Give three positive whole counts in wasm32 range.`);
  return [vector[0], vector[1], vector[2]];
}

function validGrid(grid: BoundaryLayerGrid): BoundaryLayerGrid {
  if (!grid) throw new MargoError('state', 'Boundary-layer wind needs a grid. Pass cells, origin and spacing.');
  const cells = whole(grid.cells, 'wind grid dimensions');
  const { origin, spacing } = grid;
  if (
    !Array.isArray(origin) ||
    origin.length !== 3 ||
    !origin.every(Number.isFinite) ||
    !Array.isArray(spacing) ||
    spacing.length !== 3 ||
    !spacing.every((n) => Number.isFinite(n) && n > 0)
  )
    throw new MargoError(
      'state',
      'Invalid wind grid geometry. Give local finite origin and positive spacings in metres.',
    );
  for (let i = 0; i < 3; i++) {
    const start = origin[i]!;
    const step = spacing[i]!;
    const end = start + (cells[i]! - 1) * step;
    if (!Number.isFinite(end) || (cells[i]! > 1 && (start + step === start || end - step === end)))
      throw new MargoError('state', 'Wind grid spacing is unresolved. Use a local origin or wider sample spacing.');
  }
  return Object.freeze({
    cells: Object.freeze(cells),
    origin: Object.freeze([...origin]) as Vector,
    spacing: Object.freeze([...spacing]) as Vector,
  });
}

function checkedProfile(profile: BoundaryLayerGridProfile): BoundaryLayerGridProfile {
  if (!profile) throw new MargoError('state', 'Wind profile is missing. Pass a resolved surface-layer profile.');
  const {
    roughness,
    obukhovLength: length,
    meanScale,
    psiAtRoughness,
    ground,
    altitude,
    seaLevelTemperature: temperature,
    along,
  } = profile;
  if (
    !(
      Number.isFinite(roughness) &&
      roughness > 0 &&
      (length === Infinity || (Number.isFinite(length) && length !== 0)) &&
      Number.isFinite(meanScale) &&
      meanScale >= 0 &&
      Number.isFinite(psiAtRoughness) &&
      Number.isFinite(ground) &&
      Number.isFinite(altitude) &&
      temperature > 0.0065 * 11000 &&
      Number.isFinite(temperature)
    )
  )
    throw new MargoError(
      'state',
      'Invalid wind profile. Use positive roughness and kelvin, finite scales and nonzero stability length.',
    );
  if (
    !Array.isArray(along) ||
    along.length !== 2 ||
    !(Math.abs(along[0] * along[0] + along[1] * along[1] - 1) <= 8 * Number.EPSILON)
  )
    throw new MargoError('state', 'Invalid wind direction. Pass a unit horizontal vector [x, z].');
  return profile;
}

function checkStatus(code: number): void {
  if (code !== 0)
    throw new MargoError(
      'state',
      'Boundary-layer sample is outside numeric range. Reduce the speed, altitude, extent or time.',
    );
}

/** Native surface-layer field on the world clock with an independently queryable continuous Wind interface. */
export class BoundaryLayerSolver implements Solver<BoundaryLayerOptions>, Wind {
  readonly medium = 'air' as const;
  /** Registry rows [vx, vy, vz, density, temperature], with X varying fastest, then Y and Z. */
  readonly sampleField: FieldDescriptor;
  private state?: State;
  private pool?: NativePhasePool;
  private disposed = false;

  private constructor(
    private readonly id: string,
    private readonly builds: BoundaryLayerBuilds,
  ) {
    this.sampleField = Object.freeze({
      name: id + ':samples',
      kind: 'uniformGrid',
      quantity: 'velocityDensityTemperature',
      unit: 'm/s kg/m^3 K',
      centring: 'cell',
    });
  }

  /** Loads the native boundary-layer entry and its optional shared workers. */
  static async load(options: BoundaryLayerLoadOptions = {}): Promise<BoundaryLayerSolver> {
    if (!options || typeof options !== 'object')
      throw new MargoError('state', 'Invalid boundary-layer load options. Pass an options object or omit it.');
    const { id = 'boundary-layer', threads = 1, signal } = options;
    if (typeof id !== 'string' || !id || id.trim() !== id)
      throw new MargoError('state', 'Invalid boundary-layer ID. Use a nonempty ID without outer whitespace.');
    if (!Number.isSafeInteger(threads) || threads < 1 || threads > MAX_THREADS)
      throw new MargoError('state', `Choose a whole number of boundary-layer wind threads from 1 to ${MAX_THREADS}.`);
    const builds = await loadBoundaryLayerBuilds(signal);
    const solver = new BoundaryLayerSolver(id, builds);
    if (threads > 1) {
      if (!builds.shared)
        throw new MargoError('unsupported', 'Use a shared-memory host for boundary-layer wind workers or threads: 1.');
      const { createNativePhasePool } = await import('../native-phase-pool.js');
      solver.pool = await createNativePhasePool(threads, {
        subject: 'Boundary-layer wind',
        phaseExport: 'boundary_layer_thread_phase',
        phase: 'sampling',
        signal,
      });
    }
    return solver;
  }

  /** The registered grid's current origin cell. */
  get cell(): Cell {
    return this.state?.host.cell ?? ORIGIN;
  }

  /** Clock time of the last accepted registry grid in seconds. */
  get elapsedSeconds(): number {
    const { host, clock } = this.requireState();
    return floats(host, clock)[0]!;
  }

  /** Close optional workers after removing this solver from the world. */
  [Symbol.dispose](): void {
    this.disposed = true;
    this.pool?.close();
  }

  describe(): SolverDescription {
    return { id: this.id, fields: [{ field: this.sampleField, access: 'write' }], rate: 0, stableRate: () => 0 };
  }

  init(host: SolverHost, options: BoundaryLayerOptions): void {
    if (this.disposed) throw new MargoError('disposed', 'Boundary-layer wind is disposed. Load a fresh solver.');
    if (this.state) throw new MargoError('attached', 'Boundary-layer wind already has a world. Load another solver.');
    if (this.pool && !isShared(host.memory))
      throw new MargoError('unsupported', 'Use worldMemory(true) for boundary-layer threads or use threads: 1.');
    const grid = validGrid(options?.grid);
    const profile = checkedProfile(options?.profile);
    const n = grid.cells[0] * grid.cells[1] * grid.cells[2];
    const mann = profile.turbulence;
    const dims = mann ? whole(mann.cells, 'Mann box dimensions') : ORIGIN;
    const modes = dims[0] * dims[1] * dims[2];
    const bytes = (2 * BOUNDARY_LAYER_WORDS * n + 3 * modes) * F64;
    if (!Number.isSafeInteger(bytes) || bytes >= MAX_MEMORY_PAGES * 65536 - DYNAMIC_BASE)
      throw new MargoError('state', 'Wind grid exceeds the wasm32 arena. Use fewer wind samples or turbulence cells.');
    if (
      mann &&
      (!Array.isArray(mann.size) ||
        mann.size.length !== 3 ||
        !mann.size.every((length, i) => Number.isFinite(length) && length / dims[i]! > 0) ||
        ![mann.u, mann.v, mann.w].every(
          (values) => values instanceof Float64Array && values.length === modes && values.every(Number.isFinite),
        ))
    )
      throw new MargoError(
        'state',
        'Invalid Mann box. Give finite planes and positive size matching the box dimensions.',
      );

    const module = isShared(host.memory) ? this.builds.shared : this.builds.plain;
    if (!module) throw new MargoError('unsupported', 'Shared wind kernel is unavailable. Use plain world memory.');
    const kernel = bindWind(host, module);
    const allocate = (name: string, count: number) => host.allocate('boundary-layer-' + name, count * F64, 'f64', 1);
    const output = allocate('output', n * BOUNDARY_LAYER_WORDS);
    const candidate = allocate('candidate', n * BOUNDARY_LAYER_WORDS);
    const clock = allocate('clock', 1);
    const control = allocate('profile', 7);
    const frameProfile = allocate('frame-profile', 5);
    const planes = mann ? ['u', 'v', 'w'].map((axis) => allocate('gust-' + axis, modes)) : [];
    const job = host.allocate('boundary-layer-job', JOB_BYTES, 'u32', 1);
    const oneJob = host.allocate('boundary-layer-query-job', JOB_BYTES, 'u32', 1);
    const oneSample = allocate('query-result', BOUNDARY_LAYER_WORDS);
    const workLength = RECEIPT_WORDS * (this.pool?.count ?? 1);
    const receipts = host.allocate('boundary-layer-receipts', workLength * U32, 'u32', 1);

    floats(host, control).set([
      profile.roughness,
      profile.obukhovLength,
      profile.meanScale,
      profile.psiAtRoughness,
      ...(mann?.size ?? ORIGIN),
    ]);
    if (mann) [mann.u, mann.v, mann.w].forEach((values, i) => floats(host, planes[i]!).set(values));

    const nativeProfile = [
      planes[0]?.byteOffset ?? 0,
      planes[1]?.byteOffset ?? 0,
      planes[2]?.byteOffset ?? 0,
      ...dims,
      control.byteOffset,
    ];
    new Uint32Array(host.memory.buffer, job.byteOffset, JOB_HEADER_WORDS).set([
      candidate.byteOffset,
      receipts.byteOffset,
      ...grid.cells,
      ...nativeProfile,
    ]);
    new Uint32Array(host.memory.buffer, oneJob.byteOffset, JOB_HEADER_WORDS).set([
      oneSample.byteOffset,
      0,
      1,
      1,
      1,
      ...nativeProfile,
    ]);
    const scalars = [profile.ground, profile.altitude, profile.seaLevelTemperature, ...profile.along];
    this.jobValues(host, job).set([...grid.origin, ...grid.spacing, 0, ...scalars]);
    this.jobValues(host, oneJob).set([0, 0, 0, 1, 1, 1, 0, ...scalars]);
    floats(host, frameProfile).set(scalars);
    checkStatus(kernel.boundary_layer_sample(job.byteOffset));
    floats(host, output).set(floats(host, candidate));
    if (this.pool) this.bindWorkers(host, module, job, this.pool);
    this.state = {
      host,
      kernel,
      grid,
      n,
      output,
      candidate,
      clock,
      job,
      oneJob,
      oneSample,
      receipts,
      frameProfile,
      regions: [output, clock, control, frameProfile, ...planes],
      accepted: new Uint32Array(workLength),
    };
  }

  private jobValues(host: SolverHost, job: Region): Float64Array {
    return new Float64Array(host.memory.buffer, job.byteOffset + JOB_HEADER_BYTES, JOB_VALUE_WORDS);
  }

  private bindWorkers(host: SolverHost, module: WebAssembly.Module, job: Region, pool: NativePhasePool): void {
    const control = host.allocate('boundary-layer-workers', pool.controlWords * U32, 'i32', 1);
    const stackTops = Array.from({ length: pool.count - 1 }, (_, part) =>
      windStackTop(host, `boundary-layer-worker-stack-${part + 1}`),
    );
    pool.init({ module, memory: host.memory, job: job.byteOffset, control: control.byteOffset, stackTops });
  }

  step(context: StepContext, dt: number): void {
    const { host, n, kernel, job, clock, receipts, candidate, output, accepted, frameProfile } = this.requireState();
    const time = (context.tick + 1) * dt;
    if (!(time > 0 && Number.isFinite(time)))
      throw new MargoError('state', 'Invalid boundary-layer clock. Give a finite positive world interval.');
    const params = this.jobValues(host, job);
    params[JOB_TIME] = time;
    params.set(floats(host, frameProfile), JOB_TIME + 1);
    const pool = this.pool;
    checkStatus(
      pool
        ? pool.phase(0, () => kernel.boundary_layer_thread_phase(job.byteOffset, 0, 0, pool.count))
        : kernel.boundary_layer_sample(job.byteOffset),
    );
    const result = new Uint32Array(host.memory.buffer, receipts.byteOffset, accepted.length);
    let visited = 0;
    for (let at = 0; at < result.length; at += RECEIPT_WORDS) {
      const rows = result[at]!;
      if (result[at + 1]! > rows || result[at + 2]! > rows)
        throw new MargoError('failed', 'Invalid boundary-layer work count. Rebuild the wind kernels.');
      visited += rows;
    }
    if (visited !== n)
      throw new MargoError('failed', 'Wind workers missed grid rows. Rebuild the boundary-layer assets.');
    floats(host, output).set(floats(host, candidate));
    floats(host, clock)[0] = time;
    accepted.set(result);
  }

  importPorts(): void {}

  exportPorts(tick: number): readonly Port[] {
    return [{ field: this.sampleField.name, region: this.requireState().output, tick, cell: this.cell }];
  }

  stateRegions(): readonly Region[] {
    return this.requireState().regions;
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** Get the accepted registry grid geometry, using the first sample as its origin. */
  get grid(): BoundaryLayerGrid {
    return this.requireState().grid;
  }

  /** Query signed world time and continuous local coordinates through the very same native wind profile. */
  sample(x: number, y: number, z: number, time: number, out?: FlowSample): FlowSample {
    if (![x, y, z, time].every(Number.isFinite))
      throw new MargoError(
        'state',
        'Invalid boundary-layer sample. Use finite metres in its local cell and signed seconds.',
      );
    const { host, kernel, oneJob, oneSample, frameProfile } = this.requireState();
    const position = this.jobValues(host, oneJob);
    position.set([x, y, z], 0);
    position[JOB_TIME] = time;
    position.set(floats(host, frameProfile), JOB_TIME + 1);
    checkStatus(kernel.boundary_layer_sample(oneJob.byteOffset));
    const result = out ?? { velocity: [0, 0, 0], density: 0, temperature: 0 };
    const data = floats(host, oneSample);
    result.velocity[0] = data[0]!;
    result.velocity[1] = data[1]!;
    result.velocity[2] = data[2]!;
    result.density = data[3]!;
    result.temperature = data[4]!;
    return result;
  }

  /** Native grid work from the last accepted tick. Individual Wind queries leave these counters unchanged. */
  workCounts(): BoundaryLayerWorkCounts {
    const { accepted } = this.requireState();
    const threads = accepted.length / RECEIPT_WORDS;
    let rows = 0;
    let pairedRows = 0;
    let turbulentRows = 0;
    const workers = Array.from({ length: threads }, (_, part) => {
      const at = part * RECEIPT_WORDS;
      const [r, p, t] = [accepted[at]!, accepted[at + 1]!, accepted[at + 2]!];
      rows += r;
      pairedRows += p;
      turbulentRows += t;
      return { rows: r, pairedRows: p, turbulentRows: t };
    });
    return { threads, rows, pairedRows, turbulentRows, workers };
  }

  private requireState(): State {
    if (this.disposed) throw new MargoError('disposed', 'Boundary-layer wind is disposed. Load a fresh solver.');
    if (!this.state)
      throw new MargoError('state', 'Boundary-layer wind needs a world. Add it before requesting samples.');
    return this.state;
  }
}
