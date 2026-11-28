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
import { bindOrbitKernel, loadOrbitBuilds, type OrbitBuilds, type OrbitKernel, orbitStackTop } from './kernel.js';

export {
  type KeplerDiskOptions,
  type KeplerDiskSample,
  type KeplerElements,
  type KeplerState,
  keplerDiskSample,
  keplerState,
} from './kepler.js';

/** Newton's gravitational constant in m³/(kg s²), CODATA 2022. */
export const ORBIT_GRAVITATIONAL_CONSTANT = 6.6743e-11;
/** Current f64 orbit port format. */
export const ORBIT_FIELD_LAYOUT = 1;

/** A Cartesian inertial position or velocity in SI units. */
export type OrbitVector = readonly [number, number, number];

/** One gravitating body or massless tracer, in field row order. */
export interface OrbitBodyOptions {
  /** Initial position in metres in the chosen inertial frame. */
  readonly position: OrbitVector;
  /** Initial velocity in m/s in the same inertial frame. Defaults to zero. */
  readonly velocity?: OrbitVector;
  /** Gravitational mass in kg. Zero makes this a tracer. Defaults to zero. */
  readonly mass?: number;
  /** Drag coefficient times area divided by inertial mass in m²/kg. Defaults to zero. */
  readonly dragAreaPerMass?: number;
}

/** Optional primary figure and atmosphere, coaxial with the inertial z axis. */
export interface OrbitPrimaryOptions {
  /** Index of the body carrying this radius and atmosphere. */
  readonly body: number;
  /** Reference equatorial radius in metres. */
  readonly radius: number;
  /** Signed zonal quadrupole coefficient. Defaults to zero. */
  readonly j2?: number;
  /** Atmospheric density at the reference radius in kg/m³. Defaults to zero (vacuum). */
  readonly density?: number;
  /** Exponential density scale height in metres. Defaults to 8500. */
  readonly scaleHeight?: number;
  /** Atmosphere rotation about z in rad/s. Defaults to zero. */
  readonly angularVelocity?: number;
}

/** Settings for a fixed-rate N-body simulation. */
export interface OrbitOptions {
  /** Bodies in persistent field order. At least one is required. */
  readonly bodies: readonly OrbitBodyOptions[];
  /** Optional primary figure and atmosphere. Defaults to point-mass gravity in vacuum. */
  readonly primary?: OrbitPrimaryOptions;
  /** Simulated seconds per world second. Defaults to 1. Zero freezes the solver. */
  readonly timeScale?: number;
  /** Fixed subdivisions per 60 Hz tick. Defaults to 1. Use a positive power of two. */
  readonly substeps?: number;
  /** Symplectic gravity integrator. Defaults to fourth-order Yoshida. */
  readonly integrator?: 'verlet' | 'yoshida';
  /** Plummer gravitational softening in metres. Defaults to zero (Newtonian). */
  readonly softening?: number;
  /** Gravitational constant in m³/(kg s²). Defaults to the CODATA value. */
  readonly gravitationalConstant?: number;
}

/** ID, field prefix and cancellation for the optional Wasm load. */
export interface OrbitLoadOptions {
  /** Solver ID and field prefix. Defaults to 'orbit'. */
  readonly id?: string;
  /** Native thread count including the caller. Defaults to one. More threads need shared world memory. */
  readonly threads?: number;
  /** Cancels the load with the signal's reason. */
  readonly signal?: AbortSignal;
}

/** A single body's current state. */
export interface OrbitSample {
  readonly position: OrbitVector;
  readonly velocity: OrbitVector;
  readonly mass: number;
}

/** Work executed by one native gravity partition in the last accepted tick. */
export interface OrbitWorkerWork {
  /** Number of pair distances evaluated by this partition. */
  readonly pairGeometryEvaluations: number;
  /** Number of ordered source contributions to target acceleration. */
  readonly sourceContributions: number;
}

/** Deterministic workload of the last accepted native tick. */
export interface OrbitWorkCounts extends OrbitWorkerWork {
  /** Force sweeps, including the initial sweep and one for each symplectic stage. */
  readonly forceEvaluations: number;
  /** Number of native partitions, including the caller. */
  readonly threads: number;
  /** Actual work by partition in slot order. */
  readonly workers: readonly OrbitWorkerWork[];
}

interface OrbitState {
  readonly memory: WebAssembly.Memory;
  readonly kernel: OrbitKernel;
  readonly count: number;
  readonly options: Region;
  readonly physical: Region;
  readonly controls: Region;
  readonly time: Region;
  readonly integrated: Region;
  readonly scratch: Region;
  readonly acceleration: Region;
  readonly position: Region;
  readonly velocity: Region;
  readonly regions: readonly Region[];
  readonly massiveIndices: Region;
  readonly receipts: Region;
  readonly job?: Region;
  readonly acceptedWork: Float64Array;
  forceEvaluations: number;
}

const CENTRE = [0, 0, 0] as const;
const STATE_WORDS = 6;
const BODY_WORDS = 2;
const F64_BYTES = Float64Array.BYTES_PER_ELEMENT;
const U32_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const MAX_THREADS = 64;
const WORK_WORDS = 2;
const JOB_HEADER_WORDS = 10;
const JOB_HEADER_BYTES = JOB_HEADER_WORDS * U32_BYTES;

function words(memory: WebAssembly.Memory, region: Region): Float64Array {
  return new Float64Array(memory.buffer, region.byteOffset, region.byteLength / F64_BYTES);
}

function scalar(value: number, name: string, minimum = 0): number {
  if (!Number.isFinite(value) || value < minimum)
    throw new MargoError('state', `Invalid orbit ${name}; pass a finite value at least ${minimum}.`);
  return value;
}

function vector(value: OrbitVector): OrbitVector {
  if (value?.length !== 3 || ![value[0], value[1], value[2]].every(Number.isFinite))
    throw new MargoError('state', 'Invalid orbital vector; pass three finite Cartesian coordinates.');
  return [value[0], value[1], value[2]];
}

function figure(options: OrbitOptions): readonly number[] {
  const gravity = scalar(options.gravitationalConstant ?? ORBIT_GRAVITATIONAL_CONSTANT, 'gravitational constant');
  const softening = scalar(options.softening ?? 0, 'softening');
  const primary = options.primary;
  if (!primary) return [gravity, softening, -1, 0, 0, 0, 1, 0];
  const body = primary.body;
  if (!Number.isInteger(body) || body < 0 || !((options.bodies[body]?.mass ?? 0) > 0))
    throw new MargoError('state', 'Invalid orbital primary; choose an existing body with positive mass.');
  const radius = scalar(primary.radius, 'reference radius');
  const height = scalar(primary.scaleHeight ?? 8500, 'atmosphere scale height');
  if (radius === 0 || height === 0)
    throw new MargoError('state', 'Invalid orbital primary radius or scale height; pass positive values in metres.');
  return [
    gravity,
    softening,
    body,
    radius,
    scalar(primary.j2 ?? 0, 'J2', -Infinity),
    scalar(primary.density ?? 0, 'atmosphere density'),
    height,
    scalar(primary.angularVelocity ?? 0, 'atmosphere angular velocity', -Infinity),
  ];
}

function controls(options: OrbitOptions): readonly number[] {
  const integrator = options.integrator ?? 'yoshida';
  if (integrator !== 'verlet' && integrator !== 'yoshida')
    throw new MargoError('state', 'Unknown orbit integrator; choose verlet or yoshida.');
  const substeps = options.substeps ?? 1;
  if (!Number.isSafeInteger(substeps) || substeps <= 0 || substeps > 0x80000000 || (substeps & (substeps - 1)) !== 0)
    throw new MargoError(
      'state',
      'Invalid orbital subdivisions; pass a positive power of two representable in wasm32.',
    );
  return [scalar(options.timeScale ?? 1, 'time scale'), substeps, Number(integrator === 'yoshida')];
}

function field(name: string, quantity: string, unit: string): FieldDescriptor {
  return Object.freeze({
    name,
    kind: quantity === 'time' ? 'scalarSeries' : 'bodySet',
    quantity,
    unit,
    centring: 'particle',
  });
}

function triplet(array: Float64Array, at: number): OrbitVector {
  return [array[at]!, array[at + 1]!, array[at + 2]!];
}

/** A shared-world N-body orbital solver with symmetric pair forces and optional atmospheric drag. */
export class OrbitSolver implements Solver<OrbitOptions> {
  readonly #id: string;
  readonly #builds: OrbitBuilds;
  #data: OrbitState | undefined;
  #pool?: NativePhasePool;
  #disposed = false;

  /** Three f64 coordinates per body, in metres. */
  readonly positionField: FieldDescriptor;
  /** Three f64 velocity components per body, in m/s. */
  readonly velocityField: FieldDescriptor;
  /** One f64 value, the elapsed orbital time in seconds. */
  readonly timeField: FieldDescriptor;

  private constructor(id: string, builds: OrbitBuilds) {
    this.#id = id;
    this.#builds = builds;
    this.positionField = field(id + '.position', 'position', 'm');
    this.velocityField = field(id + '.velocity', 'velocity', 'm/s');
    this.timeField = field(id + '.time', 'time', 's');
  }

  /** Loads the lazy SIMD kernel. */
  static async load(options: OrbitLoadOptions = {}): Promise<OrbitSolver> {
    if (options === null || typeof options !== 'object')
      throw new MargoError('state', 'Invalid orbit loader options. Pass an options object or omit it.');
    const id = options.id ?? 'orbit';
    if (typeof id !== 'string' || id.trim() === '' || id.trim() !== id)
      throw new MargoError('state', 'Invalid orbit solver ID; pass a nonempty identifier without outer whitespace.');
    const { threads = 1, signal } = options;
    if (!Number.isSafeInteger(threads) || threads < 1 || threads > MAX_THREADS)
      throw new MargoError('state', `Choose a whole number of orbit threads from 1 to ${MAX_THREADS}.`);
    const builds = await loadOrbitBuilds(signal);
    const solver = new OrbitSolver(id, builds);
    if (threads > 1) {
      if (!builds.shared)
        throw new MargoError('unsupported', 'Use a shared-memory runtime for orbit workers or use threads: 1.');
      const { createNativePhasePool } = await import('../native-phase-pool.js');
      solver.#pool = await createNativePhasePool(threads, {
        subject: 'Orbit',
        phaseExport: 'orbit_thread_phase',
        phase: 'gravity',
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

  /** Declares the position, velocity and integrated clock output ports. */
  describe(): SolverDescription {
    const fields: FieldUse[] = [this.positionField, this.velocityField, this.timeField].map((output) => ({
      field: output,
      access: 'write',
    }));
    return { id: this.#id, fields, rate: 0, stableRate: () => 0 };
  }

  /** Copies initial conditions into the shared world and allocates the working state. */
  init(host: SolverHost, options: OrbitOptions): void {
    this.#assertActive();
    if (this.#pool && !isShared(host.memory))
      throw new MargoError('unsupported', 'Use worldMemory(true) for orbit threads or use threads: 1.');
    if (this.#data)
      throw new MargoError('attached', 'OrbitSolver already has a world; load a fresh solver to attach again.');
    if (!Array.isArray(options?.bodies) || options.bodies.length === 0)
      throw new MargoError('state', 'OrbitSolver requires bodies; supply at least one initial position.');
    const model = figure(options);
    const stepper = controls(options);
    const prepared = Array.from(options.bodies, (body) => {
      if (body === null || typeof body !== 'object')
        throw new MargoError(
          'state',
          'Invalid orbit body. Pass an object with Cartesian position and optional velocity.',
        );
      return {
        state: [...vector(body.position), ...vector(body.velocity ?? CENTRE)],
        physical: [scalar(body.mass ?? 0, 'mass'), scalar(body.dragAreaPerMass ?? 0, 'drag area per mass')],
      };
    });
    const count = prepared.length;
    const kernel = bindOrbitKernel(host, this.#builds);
    const allocate = (name: string, size: number) =>
      host.allocate('orbit-' + name, size * F64_BYTES, 'f64', ORBIT_FIELD_LAYOUT);
    const config = allocate('config', model.length);
    const physical = allocate('bodies', count * BODY_WORDS);
    const time = allocate('time', 1);
    const step = allocate('controls', stepper.length);
    const integrated = allocate('state', count * STATE_WORDS);
    const scratch = allocate('scratch', count * STATE_WORDS);
    const acceleration = allocate('acceleration', count * 3);
    const position = allocate('position', count * 3);
    const velocity = allocate('velocity', count * 3);
    const massiveIndices = host.allocate('orbit-massive-indices', count * U32_BYTES, 'u32', 1);
    const receipts = allocate('work-receipts', WORK_WORDS * (this.#pool?.count ?? 1));
    const columns = words(host.memory, integrated);
    const bodyWords = words(host.memory, physical);
    words(host.memory, config).set(model);
    words(host.memory, step).set(stepper);
    for (let i = 0; i < count; i++) {
      columns.set(prepared[i]!.state, i * STATE_WORDS);
      bodyWords.set(prepared[i]!.physical, i * BODY_WORDS);
    }
    const data = {
      memory: host.memory,
      kernel,
      count,
      options: config,
      physical,
      controls: step,
      time,
      integrated,
      scratch,
      acceleration,
      position,
      velocity,
      regions: [config, physical, step, time, integrated, position, velocity],
      massiveIndices,
      receipts,
      acceptedWork: new Float64Array(receipts.byteLength / F64_BYTES),
      forceEvaluations: 0,
    };
    this.#publish(data, columns);
    this.#data = { ...data, job: this.#bindWorkers(host, data, this.#pool) };
  }

  #bindWorkers(host: SolverHost, state: OrbitState, pool?: NativePhasePool): Region | undefined {
    if (!pool) return undefined;
    const job = host.allocate('orbit-worker-job', JOB_HEADER_BYTES + F64_BYTES, 'u32', 1);
    const control = host.allocate('orbit-worker-control', pool.controlWords * U32_BYTES, 'i32', 1);
    const stackTops = Array.from({ length: pool.count - 1 }, (_, part) =>
      orbitStackTop(host, `orbit-worker-stack-${part + 1}`),
    );
    new Uint32Array(host.memory.buffer, job.byteOffset, JOB_HEADER_WORDS).set([
      state.scratch.byteOffset,
      state.physical.byteOffset,
      state.acceleration.byteOffset,
      state.options.byteOffset,
      state.massiveIndices.byteOffset,
      state.count,
      0,
      state.receipts.byteOffset,
    ]);
    pool.init({
      module: this.#builds.shared!,
      memory: host.memory,
      job: job.byteOffset,
      control: control.byteOffset,
      stackTops,
    });
    return job;
  }

  /** Advances one world interval using fixed symplectic substeps. */
  step(_context: StepContext, dt: number): void {
    const state = this.#state();
    const {
      memory,
      kernel,
      count,
      options,
      physical,
      controls,
      time,
      integrated,
      scratch,
      acceleration,
      massiveIndices,
      receipts,
      job,
    } = state;
    const [scale, substeps, fourthOrder] = words(memory, controls);
    if (scale === 0) return;
    const seconds = dt * scale!;
    const clock = words(memory, time);
    const nextTime = clock[0]! + seconds;
    if (!(nextTime > clock[0]! && Number.isFinite(nextTime)))
      throw new MargoError('state', 'Orbital time exceeds numeric range; choose a representable positive time scale.');
    const current = words(memory, integrated);
    const next = words(memory, scratch);
    next.set(current);
    const pool = this.#pool;
    let work: Float64Array;
    if (job && pool) {
      work = this.#stepWorkers(state, job, pool, substeps!, fourthOrder!, seconds);
    } else {
      const result = kernel.orbit_step(
        scratch.byteOffset,
        physical.byteOffset,
        acceleration.byteOffset,
        options.byteOffset,
        count,
        substeps!,
        fourthOrder!,
        seconds,
        massiveIndices.byteOffset,
        receipts.byteOffset,
      );
      this.#requireNativeSuccess(result);
      work = words(memory, receipts);
    }
    if (!next.every(Number.isFinite)) this.#requireNativeSuccess(1);
    for (let lane = 0; lane < WORK_WORDS; lane++) {
      let total = 0;
      for (let at = lane; at < work.length; at += WORK_WORDS) total += work[at]!;
      if (!Number.isSafeInteger(total) || total < 0)
        throw new MargoError('state', 'Orbit work exceeds exact numeric range. Reduce the body count or subdivisions.');
    }
    this.#publish(state, next);
    current.set(next);
    clock[0] = nextTime;
    state.acceptedWork.set(work);
    state.forceEvaluations = 1 + substeps! * (fourthOrder === 1 ? 3 : 1);
  }

  #stepWorkers(
    state: OrbitState,
    job: Region,
    pool: NativePhasePool,
    substeps: number,
    fourthOrder: number,
    seconds: number,
  ): Float64Array {
    const { memory, kernel, receipts, acceptedWork } = state;
    const pointer = job.byteOffset;
    new Uint32Array(memory.buffer, pointer, JOB_HEADER_WORDS).set([substeps, fourthOrder], 8);
    new Float64Array(memory.buffer, pointer + JOB_HEADER_BYTES, 1)[0] = seconds;
    this.#requireNativeSuccess(kernel.orbit_thread_prepare(pointer));
    const work = new Float64Array(acceptedWork.length);
    const gravity = () => {
      this.#requireNativeSuccess(pool.phase(0, () => kernel.orbit_thread_phase(pointer, 0, 0, pool.count)));
      this.#requireNativeSuccess(kernel.orbit_thread_finish_accel(pointer));
      const stepWork = words(memory, receipts);
      for (let at = 0; at < work.length; at++) work[at] = work[at]! + stepWork[at]!;
    };
    const stages = fourthOrder === 1 ? 3 : 1;
    gravity();
    for (let substep = 0; substep < substeps; substep++) {
      for (let stage = 0; stage < stages; stage++) {
        this.#requireNativeSuccess(kernel.orbit_thread_before(pointer, stage));
        gravity();
        this.#requireNativeSuccess(kernel.orbit_thread_after(pointer, stage));
      }
    }
    return work;
  }

  #requireNativeSuccess(status: number): void {
    if (status !== 0)
      throw new MargoError(
        'state',
        'Orbital step encountered a singular or unrepresentable state; reduce time scale or set softening.',
      );
  }

  /** Work from the last accepted tick. Counts start at zero and are independent of snapshot state. */
  workCounts(): OrbitWorkCounts {
    const { acceptedWork, forceEvaluations } = this.#state();
    const threads = acceptedWork.length / WORK_WORDS;
    let pairGeometryEvaluations = 0;
    let sourceContributions = 0;
    const workers = Array.from({ length: threads }, (_, part) => {
      const pairs = acceptedWork[part * WORK_WORDS]!;
      const sources = acceptedWork[part * WORK_WORDS + 1]!;
      pairGeometryEvaluations += pairs;
      sourceContributions += sources;
      return { pairGeometryEvaluations: pairs, sourceContributions: sources };
    });
    return { pairGeometryEvaluations, sourceContributions, threads, forceEvaluations, workers };
  }

  /** Input forces are evaluated internally. This solver has no incoming accumulators. */
  importPorts(_tick: number): void {}

  /** Publishes positions, velocities and time at the tick. */
  exportPorts(tick: number): readonly Port[] {
    const { position, velocity, time } = this.#state();
    return [
      { field: this.positionField.name, region: position, tick, cell: CENTRE },
      { field: this.velocityField.name, region: velocity, tick, cell: CENTRE },
      { field: this.timeField.name, region: time, tick, cell: CENTRE },
    ];
  }

  /** Identifies all state restored by a world snapshot. */
  stateRegions(): readonly Region[] {
    return this.#state().regions;
  }

  /** All forces are recomputed from the saved state. */
  extraState(): readonly Region[] {
    return [];
  }

  /** Simulated time in seconds since this solver's initialization. */
  get elapsedSeconds(): number {
    const { memory, time } = this.#state();
    return words(memory, time)[0]!;
  }

  /** Reads a body by its index in the input array. */
  sample(body: number): OrbitSample {
    const { memory, count, integrated, physical } = this.#state();
    if (!Number.isInteger(body) || body < 0 || body >= count)
      throw new MargoError('state', `Orbit body index is out of range; use an integer from 0 to ${count - 1}.`);
    const state = words(memory, integrated);
    return {
      position: triplet(state, body * STATE_WORDS),
      velocity: triplet(state, body * STATE_WORDS + 3),
      mass: words(memory, physical)[body * BODY_WORDS]!,
    };
  }

  #publish(state: OrbitState, integrated: Float64Array): void {
    const position = words(state.memory, state.position);
    const velocity = words(state.memory, state.velocity);
    for (let i = 0; i < state.count; i++) {
      position.set(integrated.subarray(i * STATE_WORDS, i * STATE_WORDS + 3), 3 * i);
      velocity.set(integrated.subarray(i * STATE_WORDS + 3, (i + 1) * STATE_WORDS), 3 * i);
    }
  }

  #assertActive(): void {
    if (this.#disposed)
      throw new MargoError('disposed', 'OrbitSolver is disposed. Load a new solver before adding it.');
  }

  #state(): OrbitState {
    this.#assertActive();
    if (!this.#data) throw new MargoError('state', 'OrbitSolver has no world; add it to a PhysicsWorld before use.');
    return this.#data;
  }
}
