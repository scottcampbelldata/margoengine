import { MargoError } from '@margoengine/math/errors';
import type { NativePhasePool } from '../native-phase-pool.js';
import { isShared } from '../world/memory.js';
import type {
  FieldDescriptor,
  FieldUse,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import {
  type AcousticBuilds,
  type AcousticKernel,
  acousticStackTop,
  bindAcousticKernel,
  loadAcousticBuilds,
} from './kernel.js';
import { layerSpeed, prepareProfile, PROFILE_WORDS, type SoundSpeedKnot, soundLayer } from './profile.js';
import {
  acousticBeamPressure,
  type AcousticRayOptions,
  type AcousticRaySample,
  advanceRay,
  initializeRay,
  sampleRay,
  TRACE_WORDS,
} from './trace.js';

export type { SoundSpeedKnot } from './profile.js';
export {
  acousticBeamPressure,
  type AcousticPressure,
  type AcousticRayOptions,
  type AcousticRaySample,
} from './trace.js';

/** Version of the underwater acoustic ports, each using f64 rows. */
export const ACOUSTIC_FIELD_LAYOUT = 1;

/** One sound-speed profile, its boundaries and launch directions. */
export interface UnderwaterAcousticsOptions {
  /** Speed in m/s versus metres below the surface. Defaults to 1500 m/s from 0 to 100 metres. */
  readonly profile?: readonly SoundSpeedKnot[];
  /** Initial rays and Gaussian beams in port row order. Defaults to one horizontal ray at mid-depth. */
  readonly rays?: readonly AcousticRayOptions[];
  /** Signed pressure factor per flat surface reflection, from -1 to 1. Defaults to -1 for a pressure-release surface. */
  readonly surfaceReflection?: number;
  /** Signed pressure factor per flat bottom reflection, from -1 to 1. Defaults to 0.8. */
  readonly bottomReflection?: number;
  /** Pressure attenuation of the water in dB/km. Defaults to 0. */
  readonly absorption?: number;
}

/** Solver ID and registry field-name prefix. */
export interface UnderwaterAcousticsSolverOptions {
  /** Unique ID, also used to form the port names. Defaults to 'underwater-acoustics'. */
  readonly id?: string;
}

/** Options for the lazy native ray tracer. */
export interface UnderwaterAcousticsLoadOptions extends UnderwaterAcousticsSolverOptions {
  /** Native thread count including the caller. Defaults to one. More threads need shared world memory. */
  readonly threads?: number;
  /** Cancels compilation or worker startup. */
  readonly signal?: AbortSignal;
}

/** Deterministic trace work completed in one partition of the last accepted tick. */
export interface AcousticWorkerWork {
  /** Rays traced, including rays that reach no boundary. */
  readonly rays: number;
  /** Positive-duration beam drifts executed, with one per analytically folded uniform trace. */
  readonly driftIntegrals: number;
  /** Physical surface, bottom and layer transitions, including analytically folded reflections. */
  readonly boundaryCrossings: number;
}

/** Trace work over all partitions of the last accepted tick. */
export interface AcousticWorkCounts extends AcousticWorkerWork {
  /** Number of partitions, including the caller. */
  readonly threads: number;
  /** Actual work from each partition in native row order. */
  readonly workers: readonly AcousticWorkerWork[];
}

const DEFAULT_PROFILE: readonly SoundSpeedKnot[] = [
  { depth: 0, speed: 1500 },
  { depth: 100, speed: 1500 },
];
const CENTRE = [0, 0, 0] as const;
const F64_BYTES = Float64Array.BYTES_PER_ELEMENT;
const PATH_WORDS = 4;
const SIGNAL_WORDS = 2;
const OUTPUT_WORDS = PATH_WORDS + SIGNAL_WORDS + 1;

const WORK_WORDS = 3;
const JOB_HEADER_WORDS = 6;
const JOB_HEADER_BYTES = JOB_HEADER_WORDS * Uint32Array.BYTES_PER_ELEMENT;
const JOB_BYTES = JOB_HEADER_BYTES + F64_BYTES;
const MAX_THREADS = 64;

interface AcousticNativeState {
  readonly kernel: AcousticKernel;
  readonly receipts: Region;
  readonly job?: Region;
}

interface AcousticState {
  readonly memory: WebAssembly.Memory;
  readonly n: number;
  readonly settings: Region;
  readonly profile: Region;
  readonly rays: Region;
  readonly scratch: Region;
  readonly path: Region;
  readonly signal: Region;
  readonly delay: Region;
  readonly regions: readonly Region[];
  readonly native?: AcousticNativeState;
  readonly work: Float64Array;
}

function words(memory: WebAssembly.Memory, region: Region): Float64Array {
  return new Float64Array(memory.buffer, region.byteOffset, region.byteLength / F64_BYTES);
}

function field(name: string, quantity: string, unit: string): FieldDescriptor {
  return Object.freeze({ name, kind: 'scalarSeries', quantity, unit, centring: 'cell' });
}

function reflection(value: number): number {
  if (!Number.isFinite(value) || value < -1 || value > 1)
    throw new MargoError(
      'state',
      'Invalid acoustic reflection coefficient; pass a signed pressure ratio from -1 to 1.',
    );
  return value;
}

/** A 60 Hz ray and Gaussian-beam model for sound propagating through a layered water column. */
export class UnderwaterAcousticsSolver implements Solver<UnderwaterAcousticsOptions> {
  readonly #id: string;
  #data: AcousticState | undefined;
  #builds?: AcousticBuilds;
  #pool?: NativePhasePool;
  #disposed = false;

  /** One f64 row per ray: range, depth, integrated path length and beam width, in metres. */
  readonly pathField: FieldDescriptor;
  /** One f64 row per ray: real and imaginary axis pressure in Pa. */
  readonly signalField: FieldDescriptor;
  /** One f64 value per ray: travel time in seconds. */
  readonly delayField: FieldDescriptor;

  constructor(options: UnderwaterAcousticsSolverOptions = {}) {
    if (options === null || typeof options !== 'object')
      throw new MargoError('state', 'Invalid underwater acoustics options. Pass an options object or omit it.');
    this.#id = options.id ?? 'underwater-acoustics';
    if (typeof this.#id !== 'string' || this.#id.trim() === '' || this.#id.trim() !== this.#id)
      throw new MargoError('state', 'Invalid underwater acoustics ID; pass a nonempty ID without outer whitespace.');
    this.pathField = field(this.#id + '.path', 'length', 'm');
    this.signalField = field(this.#id + '.signal', 'pressure', 'Pa');
    this.delayField = field(this.#id + '.delay', 'time', 's');
  }

  /** Load the optional Wasm tracer and start any requested native ray workers. */
  static async load(options: UnderwaterAcousticsLoadOptions = {}): Promise<UnderwaterAcousticsSolver> {
    const solver = new UnderwaterAcousticsSolver(options);
    const { threads = 1, signal } = options;
    if (!Number.isSafeInteger(threads) || threads < 1 || threads > MAX_THREADS)
      throw new MargoError('state', `Choose a whole number of underwater acoustic threads from 1 to ${MAX_THREADS}.`);
    const builds = await loadAcousticBuilds(signal);
    solver.#builds = builds;
    if (threads > 1) {
      if (!builds.shared)
        throw new MargoError('unsupported', 'Use a shared-memory runtime for underwater workers or use threads: 1.');
      const { createNativePhasePool } = await import('../native-phase-pool.js');
      solver.#pool = await createNativePhasePool(threads, {
        subject: 'Underwater',
        phaseExport: 'underwater_thread_phase',
        phase: 'ray trace',
        signal,
      });
    }
    return solver;
  }

  /** Close the native workers after removing the solver from its world. */
  [Symbol.dispose](): void {
    this.#disposed = true;
    this.#pool?.close();
  }

  /** Describes the path, pressure and delay fields at a dyadic 60 Hz. */
  describe(): SolverDescription {
    const fields: FieldUse[] = [this.pathField, this.signalField, this.delayField].map((output) => ({
      field: output,
      access: 'write',
    }));
    return { id: this.#id, fields, rate: 0, stableRate: () => 0 };
  }

  /** Validates and copies the profile and launch conditions into world memory. */
  init(host: SolverHost, options: UnderwaterAcousticsOptions = {}): void {
    this.#assertActive();
    if (this.#pool && !isShared(host.memory))
      throw new MargoError('unsupported', 'Use worldMemory(true) for underwater acoustic threads or use threads: 1.');
    if (this.#data)
      throw new MargoError(
        'attached',
        'Underwater acoustics is already attached; create a fresh solver for a new world.',
      );
    if (options === null || typeof options !== 'object')
      throw new MargoError('state', 'Invalid acoustic column options. Pass a profile and rays in an options object.');
    const packed = prepareProfile(options.profile ?? DEFAULT_PROFILE);
    const launches = options.rays ?? [{}];
    if (!Array.isArray(launches) || launches.length === 0)
      throw new MargoError('state', 'No acoustic rays are configured; pass at least one launch condition.');
    const rows = Array.from(launches, (launch) => initializeRay(packed, launch));
    const surface = reflection(options.surfaceReflection ?? -1);
    const bottom = reflection(options.bottomReflection ?? 0.8);
    const absorption = options.absorption ?? 0;
    if (!(absorption >= 0 && Number.isFinite(absorption)))
      throw new MargoError('state', 'Invalid acoustic absorption; pass a finite nonnegative loss in dB/km.');
    const n = rows.length;
    const allocate = (name: string, count: number) =>
      host.allocate(name, count * F64_BYTES, 'f64', ACOUSTIC_FIELD_LAYOUT);
    const settings = allocate('acoustic-settings', 3);
    const profile = allocate('acoustic-profile', packed.length);
    const rays = allocate('acoustic-rays', n * TRACE_WORDS);
    const path = allocate('acoustic-path', n * PATH_WORDS);
    const signal = allocate('acoustic-signal', n * SIGNAL_WORDS);
    const delay = allocate('acoustic-delay', n);
    const scratch = allocate('acoustic-scratch', n * (TRACE_WORDS + OUTPUT_WORDS));
    words(host.memory, settings).set([surface, bottom, absorption]);
    words(host.memory, profile).set(packed);
    const initial = words(host.memory, rays);
    for (let i = 0; i < n; i++) initial.set(rows[i]!, i * TRACE_WORDS);
    const data = {
      memory: host.memory,
      n,
      settings,
      profile,
      rays,
      scratch,
      path,
      signal,
      delay,
      regions: [settings, profile, rays, path, signal, delay],
      work: new Float64Array(WORK_WORDS * (this.#pool?.count ?? 1)),
    };
    this.#publish(data, packed, initial, absorption);
    this.#data = { ...data, native: this.#bindNative(host, n, profile, scratch, settings) };
  }

  #bindNative(
    host: SolverHost,
    n: number,
    profile: Region,
    candidate: Region,
    settings: Region,
  ): AcousticNativeState | undefined {
    const builds = this.#builds;
    if (!builds) return undefined;
    const module = isShared(host.memory) ? builds.shared : builds.plain;
    if (!module)
      throw new MargoError('unsupported', 'The shared underwater kernel is unavailable. Create a plain-memory world.');
    const kernel = bindAcousticKernel(host, module);
    const pool = this.#pool;
    const receipts = host.allocate('acoustic-native-receipts', WORK_WORDS * (pool?.count ?? 1) * F64_BYTES, 'f64', 1);
    if (!pool) return { kernel, receipts };
    const job = host.allocate('acoustic-worker-job', JOB_BYTES, 'u32', 1);
    const control = host.allocate(
      'acoustic-worker-control',
      pool.controlWords * Uint32Array.BYTES_PER_ELEMENT,
      'i32',
      1,
    );
    const stackTops = Array.from({ length: pool.count - 1 }, (_, part) =>
      acousticStackTop(host, `acoustic-worker-stack-${part + 1}`),
    );
    new Uint32Array(host.memory.buffer, job.byteOffset, JOB_HEADER_WORDS).set([
      profile.byteOffset,
      profile.byteLength / F64_BYTES,
      candidate.byteOffset,
      n,
      settings.byteOffset,
      receipts.byteOffset,
    ]);
    pool.init({ module, memory: host.memory, job: job.byteOffset, control: control.byteOffset, stackTops });
    return { kernel, receipts, job };
  }

  /** Traces boundary crossings and advances wavefront curvature and width by one world step. */
  step(_context: StepContext, dt: number): void {
    const data = this.#state();
    if (!Number.isFinite(dt) || dt <= 0)
      throw new MargoError(
        'state',
        'Invalid underwater acoustic interval. You must advance by positive finite seconds.',
      );
    const { memory, n, settings, profile, rays, scratch, native, work } = data;
    const [surface, bottom, absorption] = words(memory, settings);
    const layers = words(memory, profile);
    const state = words(memory, rays);
    const next = words(memory, scratch).subarray(0, n * TRACE_WORDS);
    next.set(state);
    const receipt = native ? this.#traceNative(data, native, dt) : new Float64Array(WORK_WORDS);
    if (!native) for (let i = 0; i < n; i++) advanceRay(layers, next, i * TRACE_WORDS, dt, surface!, bottom!, receipt);
    if (!native && !next.every(Number.isFinite))
      throw new MargoError(
        'state',
        'Acoustic trace exceeds numeric range; reduce the profile gradient or use a shorter interval.',
      );
    const totals = [0, 0, 0];
    for (let at = 0; at < receipt.length; at++) {
      const count = receipt[at]!;
      const field = at % WORK_WORDS;
      const sum = totals[field]! + count;
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(sum))
        throw new MargoError(
          'state',
          'Acoustic trace work exceeds exact numeric range. Use fewer rays or deeper layers.',
        );
      totals[field] = sum;
    }
    if (totals[0] !== n)
      throw new MargoError('failed', 'Acoustic tracing missed ray rows. You must rebuild the native kernel.');
    this.#publish(data, layers, next, absorption!);
    state.set(next);
    work.set(receipt);
  }

  #traceNative(data: AcousticState, native: AcousticNativeState, dt: number): Float64Array {
    const { memory, n, profile, settings, scratch } = data;
    const { job, kernel, receipts } = native;
    const pool = this.#pool;
    let status: number;
    if (job && pool) {
      new Float64Array(memory.buffer, job.byteOffset + JOB_HEADER_BYTES, 1)[0] = dt;
      status = pool.phase(0, () => kernel.underwater_thread_phase(job.byteOffset, 0, 0, pool.count));
    } else {
      status = kernel.underwater_trace(
        profile.byteOffset,
        profile.byteLength / F64_BYTES,
        scratch.byteOffset,
        n,
        settings.byteOffset,
        dt,
        receipts.byteOffset,
      );
    }
    if (status === 2)
      throw new MargoError(
        'state',
        'The acoustic layer transit is below floating-point time resolution. Increase the separation between profile knots.',
      );
    if (status === 4)
      throw new MargoError(
        'state',
        'Acoustic reflection count exceeds exact numeric range. Increase the water depth or shorten the run.',
      );
    if (status !== 0)
      throw new MargoError(
        'state',
        'Acoustic native trace exceeds numeric range. Reduce the profile gradient or interval.',
      );
    return words(memory, receipts);
  }

  /** Actual trace work in the last accepted tick. Counts start at zero and are excluded from snapshots. */
  workCounts(): AcousticWorkCounts {
    const { work } = this.#state();
    const threads = work.length / WORK_WORDS;
    let rays = 0;
    let driftIntegrals = 0;
    let boundaryCrossings = 0;
    const workers = Array.from({ length: threads }, (_, part) => {
      const offset = part * WORK_WORDS;
      const traced = work[offset]!;
      const drifts = work[offset + 1]!;
      const crossings = work[offset + 2]!;
      rays += traced;
      driftIntegrals += drifts;
      boundaryCrossings += crossings;
      return { rays: traced, driftIntegrals: drifts, boundaryCrossings: crossings };
    });
    return { threads, rays, driftIntegrals, boundaryCrossings, workers };
  }

  /** The acoustic ports are output-only and have no incoming accumulators. */
  importPorts(_tick: number): void {}

  /** Publishes the f64 path, pressure and travel time regions. */
  exportPorts(tick: number): readonly Port[] {
    const { path, signal, delay } = this.#state();
    return [
      { field: this.pathField.name, region: path, tick, cell: CENTRE },
      { field: this.signalField.name, region: signal, tick, cell: CENTRE },
      { field: this.delayField.name, region: delay, tick, cell: CENTRE },
    ];
  }

  /** All physical and exported state is included in the world's snapshot. */
  stateRegions(): readonly Region[] {
    return this.#state().regions;
  }

  /** The beam's phase and launch parameters are stored in its ray region. */
  extraState(): readonly Region[] {
    return [];
  }

  /** Current central ray and Gaussian beam, indexed by the launch array. */
  sample(ray: number): AcousticRaySample {
    const { memory, rays, profile, settings, n } = this.#state();
    if (!Number.isInteger(ray) || ray < 0 || ray >= n)
      throw new MargoError('state', `Acoustic ray index is out of range; pass an integer from 0 to ${n - 1}.`);
    return sampleRay(words(memory, profile), words(memory, rays), ray * TRACE_WORDS, words(memory, settings)[2]!);
  }

  /** Reads the piecewise-linear sound speed in m/s at a depth in metres. */
  soundSpeed(depth: number): number {
    const { memory, profile } = this.#state();
    const data = words(memory, profile);
    return layerSpeed(data, soundLayer(data, depth, true) * PROFILE_WORDS, depth);
  }

  #publish(data: AcousticState, layers: Float64Array, rays: Float64Array, absorption: number): void {
    const output = words(data.memory, data.scratch).subarray(data.n * TRACE_WORDS);
    const signalStart = data.n * PATH_WORDS;
    const delaysStart = signalStart + data.n * SIGNAL_WORDS;
    for (let i = 0; i < data.n; i++) {
      const sample = sampleRay(layers, rays, i * TRACE_WORDS, absorption);
      if (!Number.isFinite(sample.curvature) || !(sample.width > 0 && Number.isFinite(sample.width)))
        throw new MargoError(
          'state',
          'Acoustic beam width or curvature exceeds numeric range; adjust launch frequency or beam waist.',
        );
      const pressure = acousticBeamPressure(sample, 0);
      output.set([sample.range, sample.depth, sample.pathLength, sample.width], PATH_WORDS * i);
      output.set([pressure.real, pressure.imaginary], signalStart + SIGNAL_WORDS * i);
      output[delaysStart + i] = sample.travelTime;
    }
    if (!output.every(Number.isFinite))
      throw new MargoError('state', 'Acoustic output exceeds numeric range; reduce launch pressure or frequency.');
    words(data.memory, data.path).set(output.subarray(0, signalStart));
    words(data.memory, data.signal).set(output.subarray(signalStart, delaysStart));
    words(data.memory, data.delay).set(output.subarray(delaysStart));
  }

  #assertActive(): void {
    if (this.#disposed)
      throw new MargoError('disposed', 'Underwater acoustics is disposed. Create a new solver for the world.');
  }

  #state(): AcousticState {
    this.#assertActive();
    if (!this.#data)
      throw new MargoError('state', 'Underwater acoustics has no world; add the solver to a PhysicsWorld first.');
    return this.#data;
  }
}
