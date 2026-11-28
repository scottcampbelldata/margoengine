import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, isShared } from './world/memory.js';

/** Offsets in the shared i32 control region. Status has one word per worker, in partition order. */
export const NATIVE_PHASE_CONTROL = { generation: 0, stage: 1, ready: 2, done: 3, fault: 4, status: 5 } as const;

// Each solver names its own phase label here and passes it to createNativePhasePool, so an entry carries only its
// own label; a shared label table made every pool user pay for every other solver's.
type NativePhaseSolver =
  | { readonly subject: 'Tsunami'; readonly phaseExport: 'tsunami_thread_phase'; readonly phase: 'flux' }
  | { readonly subject: 'Lightning'; readonly phaseExport: 'lightning_thread_phase'; readonly phase: 'relaxation' }
  | { readonly subject: 'Lava'; readonly phaseExport: 'lava_thread_phase'; readonly phase: 'native' }
  | { readonly subject: 'Viscoplastic'; readonly phaseExport: 'viscoplastic_thread_phase'; readonly phase: 'transfer' }
  | { readonly subject: 'Underwater'; readonly phaseExport: 'underwater_thread_phase'; readonly phase: 'ray trace' }
  | { readonly subject: 'Orbit'; readonly phaseExport: 'orbit_thread_phase'; readonly phase: 'gravity' }
  | { readonly subject: 'Runoff'; readonly phaseExport: 'runoff_thread_phase'; readonly phase: 'soil' }
  | { readonly subject: 'Landscape'; readonly phaseExport: 'landscape_thread_phase'; readonly phase: 'terrain' }
  | { readonly subject: 'Sediment'; readonly phaseExport: 'sediment_thread_phase'; readonly phase: 'transport' }
  | {
      readonly subject: 'Boundary-layer wind';
      readonly phaseExport: 'boundary_layer_thread_phase';
      readonly phase: 'sampling';
    }
  | {
      readonly subject: 'Cloud projection';
      readonly phaseExport: 'cloud_projection_thread_phase';
      readonly phase: 'matrix';
    }
  | { readonly subject: 'Airborne'; readonly phaseExport: 'airborne_thread_phase'; readonly phase: 'parcel' }
  | { readonly subject: 'Swimmer'; readonly phaseExport: 'swim_thread_phase'; readonly phase: 'hydrodynamic' }
  | {
      readonly subject: 'Plant sway';
      readonly phaseExport: 'vegetation_thread_phase';
      readonly phase: 'modal response';
    }
  | {
      readonly subject: 'Wind traction';
      readonly phaseExport: 'wind_traction_thread_phase';
      readonly phase: 'surface load';
    }
  | { readonly subject: 'Drainage fog'; readonly phaseExport: 'fog_thread_phase'; readonly phase: 'moist-air column' }
  | { readonly subject: 'Aeolian'; readonly phaseExport: 'aeolian_thread_phase'; readonly phase: 'saltation' }
  | { readonly subject: 'Rail wire'; readonly phaseExport: 'rail_wire_thread_phase'; readonly phase: 'catenary' }
  | {
      readonly subject: 'Room acoustics';
      readonly phaseExport: 'acoustic_wave_thread_phase';
      readonly phase: 'pressure stencil';
    }
  | {
      readonly subject: 'Wing lattice';
      readonly phaseExport: 'flight_lattice_thread_phase';
      readonly phase: 'matrix and wake';
    }
  | {
      readonly subject: 'Outdoor sound';
      readonly phaseExport: 'outdoor_sound_thread_phase';
      readonly phase: 'path quadrature';
    }
  | {
      readonly subject: 'Foam transport';
      readonly phaseExport: 'foam_transport_thread_phase';
      readonly phase: 'directional flux';
    }
  | {
      readonly subject: 'Entry profile';
      readonly phaseExport: 'entry_profile_thread_phase';
      readonly phase: 'section clipping';
    }
  | {
      readonly subject: 'Flood volume';
      readonly phaseExport: 'flood_volume_thread_phase';
      readonly phase: 'compartment clipping';
    }
  | {
      readonly subject: 'Tracer diffusion';
      readonly phaseExport: 'tracer_random_thread_phase';
      readonly phase: 'Brownian draws';
    }
  | {
      readonly subject: 'Thin film';
      readonly phaseExport: 'thin_film_thread_phase';
      readonly phase: 'capillary matrix';
    }
  | {
      readonly subject: 'Crush shell';
      readonly phaseExport: 'crush_shell_thread_phase';
      readonly phase: 'membrane evaluation';
    }
  | {
      readonly subject: 'Wave pairs';
      readonly phaseExport: 'rogue_pair_thread_phase';
      readonly phase: 'second-order interactions';
    }
  | {
      readonly subject: 'Wave transport';
      readonly phaseExport: 'wave_transport_thread_phase';
      readonly phase: 'spectral flux sweeps';
    }
  | {
      readonly subject: 'Surf force';
      readonly phaseExport: 'surf_force_thread_phase';
      readonly phase: 'wave moments and stress divergence';
    }
  | {
      readonly subject: 'Surge potential';
      readonly phaseExport: 'surge_potential_thread_phase';
      readonly phase: 'tides and inverse barometer';
    }
  | {
      readonly subject: 'Falling bodies';
      readonly phaseExport: 'falling_thread_phase';
      readonly phase: 'Runge–Kutta flight';
    }
  | {
      readonly subject: 'Pack ice';
      readonly phaseExport: 'pack_ice_thread_phase';
      readonly phase: 'planar floe drift';
    }
  | {
      readonly subject: 'Snowpack';
      readonly phaseExport: 'snowpack_thread_phase';
      readonly phase: 'column enthalpy';
    }
  | {
      readonly subject: 'Iceberg';
      readonly phaseExport: 'iceberg_thread_phase';
      readonly phase: 'body hydrodynamics';
    }
  | {
      readonly subject: 'Glacier';
      readonly phaseExport: 'glacier_thread_phase';
      readonly phase: 'flow weights and crevasses';
    }
  | {
      readonly subject: 'Locomotion';
      readonly phaseExport: 'locomotion_thread_phase';
      readonly phase: 'body contact integration';
    }
  | {
      readonly subject: 'Groundwater';
      readonly phaseExport: 'groundwater_thread_phase';
      readonly phase: 'aquifer conductance';
    }
  | {
      readonly subject: 'Vortex water stress';
      readonly phaseExport: 'vortex_water_thread_phase';
      readonly phase: 'water pressure and stress';
    }
  | {
      readonly subject: 'Resistive soil';
      readonly phaseExport: 'resistive_soil_thread_phase';
      readonly phase: 'granular strip forces';
    }
  | {
      readonly subject: 'Ice thermodynamics';
      readonly phaseExport: 'ice_thermal_thread_phase';
      readonly phase: 'phase energy';
    }
  | {
      readonly subject: 'Heat conduction';
      readonly phaseExport: 'thermal_thread_phase';
      readonly phase: 'enthalpy decode and conduction stencil';
    }
  | {
      readonly subject: 'Modal sound';
      readonly phaseExport: 'modal_sound_thread_phase';
      readonly phase: 'audio blocks';
    }
  | {
      readonly subject: 'Material ageing';
      readonly phaseExport: 'ageing_thread_phase';
      readonly phase: 'material exposure patches';
    }
  | {
      readonly subject: 'Celestial ephemeris';
      readonly phaseExport: 'celestial_thread_phase';
      readonly phase: 'analytic planetary orbits';
    }
  | {
      readonly subject: 'Accretion disk';
      readonly phaseExport: 'accretion_thread_phase';
      readonly phase: 'density, heating and orbital phase';
    }
  | {
      readonly subject: 'Strands';
      readonly phaseExport: 'strand_predict_phase';
      readonly phase: 'point prediction';
    }
  | {
      readonly subject: 'Pedestrians';
      readonly phaseExport: 'pedestrian_thread_phase';
      readonly phase: 'walker drive and wall integration';
    }
  | {
      readonly subject: 'Synoptic weather';
      readonly phaseExport: 'synoptic_publish_phase';
      readonly phase: 'regional diagnostics';
    }
  | {
      readonly subject: 'Seismic';
      readonly phaseExport: 'seismic_thread_phase';
      readonly phase: 'velocity and stress stencil';
    };

export type NativePhasePoolOptions = NativePhaseSolver & { readonly signal?: AbortSignal };

export interface NativePhaseWorkerStart {
  readonly phaseExport: NativePhaseSolver['phaseExport'];
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly stackTop: number;
  readonly control: number;
  readonly job: number;
  readonly part: number;
  readonly parts: number;
}

interface ThreadBinding {
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly control: number;
  readonly job: number;
  readonly stackTops: readonly number[];
}

interface ThreadWorker {
  post(start: NativePhaseWorkerStart): void;
  observe(ready: () => void, failed: (reason: unknown) => void): void;
  unref(): void;
  close(): void;
}

// Deadlines bound transport failures. Once a phase joins, its numerical result has no wall-clock input.
const DEADLINE_MS = 10_000;
const slots = NATIVE_PHASE_CONTROL;

function failedThreads(subject: NativePhaseSolver['subject'], reason: string, cause?: unknown): MargoError {
  return Object.assign(
    new MargoError(
      'failed',
      `${subject} workers ${reason}. Load a new solver with working worker assets or threads: 1.`,
    ),
    { cause },
  );
}

function assertThreadEnvironment(subject: NativePhaseSolver['subject']): void {
  if (canShareMemory()) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 0);
      return;
    } catch {
      // Browser window agents cannot block. The world step must stay synchronous.
    }
  }
  throw new MargoError(
    'unsupported',
    `${subject} threads need a blocking agent and shared memory. Use Node, a cross-origin-isolated browser worker, or threads: 1.`,
  );
}

async function startWorker(): Promise<ThreadWorker> {
  if (typeof Worker === 'function') {
    // The Physics builder exposes this static URL to consumer bundlers.
    const worker = new Worker(new URL(/* @vite-ignore */ './solver-phase-thread.js', import.meta.url), {
      type: 'module',
    });
    // Chromium can defer a nested Worker's startup message while its owner
    // waits. Connect a port during async boot so the later bind can wake it.
    const { port1, port2 } = new MessageChannel();
    return {
      post: (message) => port1.postMessage(message),
      observe(ready, failed) {
        port1.onmessage = ({ data }) => {
          if (data === 'ready') ready();
        };
        port1.onmessageerror = failed;
        worker.onerror = (event) => failed(event.error ?? event.message);
        worker.onmessageerror = failed;
        worker.postMessage(port2, [port2]);
      },
      unref() {},
      close() {
        port1.close();
        worker.terminate();
      },
    };
  }
  const name = 'node:worker_threads';
  const { Worker: NodeWorker } = (await import(/* @vite-ignore */ /* webpackIgnore: true */ name)) as {
    Worker: new (
      url: URL,
      options: { execArgv: string[] },
    ) => {
      on(event: 'message' | 'messageerror' | 'error' | 'exit', listener: (value: unknown) => void): void;
      postMessage(message: NativePhaseWorkerStart): void;
      unref(): void;
      terminate(): Promise<number>;
    };
  };
  // The entry is a packaged ES module. Do not inherit eval, test, or REPL flags from its host.
  const url = new URL(/* @vite-ignore */ './solver-phase-thread.js', import.meta.url);
  const worker = new NodeWorker(url, { execArgv: [] });
  return {
    post: (message) => worker.postMessage(message),
    observe(ready, failed) {
      worker.on('message', (message) => {
        if (message === 'ready') ready();
      });
      worker.on('error', failed);
      worker.on('messageerror', failed);
      worker.on('exit', failed);
    },
    unref: () => worker.unref(),
    close: () => void worker.terminate(),
  };
}

async function waitForWorkerBoot(worker: ThreadWorker, signal: AbortSignal): Promise<void> {
  let abort!: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason);
      worker.observe(resolve, reject);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    worker.unref();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** The pool owns only workers. Its job, control and stacks are unsnapshotted regions owned by the solver. */
export class NativePhasePool {
  readonly count: number;
  readonly controlWords: number;
  private binding?: ThreadBinding;
  private closed = false;

  constructor(
    private readonly workers: readonly ThreadWorker[],
    private readonly solver: NativePhaseSolver,
  ) {
    this.count = workers.length + 1;
    this.controlWords = slots.status + workers.length;
  }

  init(binding: ThreadBinding): void {
    const { subject } = this.solver;
    if (this.closed || this.binding)
      throw new MargoError(
        'state',
        `${subject} worker pool is already bound or closed. Load a new ${subject.toLowerCase()} solver.`,
      );
    if (!isShared(binding.memory)) {
      this.close();
      throw new MargoError(
        'unsupported',
        `${subject} threads need shared world memory. Use worldMemory(true) or threads: 1.`,
      );
    }
    if (binding.stackTops.length !== this.workers.length) {
      this.close();
      throw new MargoError(
        'state',
        `Give each ${subject.toLowerCase()} worker its own stack top in the shared world arena.`,
      );
    }
    this.binding = binding;
    try {
      const control = this.control();
      control.fill(0);
      for (const [i, worker] of this.workers.entries()) {
        worker.post({
          phaseExport: this.solver.phaseExport,
          module: binding.module,
          memory: binding.memory,
          control: binding.control,
          job: binding.job,
          stackTop: binding.stackTops[i]!,
          part: i + 1,
          parts: this.count,
        });
      }
      this.waitFor(control, slots.ready, 'did not initialize');
    } catch (cause) {
      this.close();
      if (cause instanceof MargoError) throw cause;
      throw failedThreads(subject, 'did not initialize', cause);
    }
  }

  /** Run native parts concurrently and return a native status in canonical part order. */
  phase(stage: number, leader: () => number): number {
    const { subject, phase } = this.solver;
    if (this.closed || !this.binding)
      throw new MargoError(
        'state',
        `${subject} workers are not available. Load a new solver with threads: 1 or working workers.`,
      );
    try {
      const control = this.control();
      Atomics.store(control, slots.done, 0);
      Atomics.store(control, slots.stage, stage);
      Atomics.add(control, slots.generation, 1);
      Atomics.notify(control, slots.generation);
      const status = leader();
      this.waitFor(control, slots.done, `did not finish a ${phase} phase`);
      if (status !== 0) return status;
      for (let i = 0; i < this.workers.length; i++) {
        const workerStatus = Atomics.load(control, slots.status + i);
        if (workerStatus !== 0) return workerStatus;
      }
      return 0;
    } catch (cause) {
      this.close();
      if (cause instanceof MargoError) throw cause;
      throw failedThreads(subject, `trapped in a ${phase} phase`, cause);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const worker of this.workers) worker.close();
    this.binding = undefined;
  }

  private control(): Int32Array {
    const { memory, control } = this.binding!;
    return new Int32Array(memory.buffer, control, this.controlWords);
  }

  private waitFor(control: Int32Array, slot: number, failure: string): void {
    const limit = performance.now() + DEADLINE_MS;
    for (;;) {
      const seen = Atomics.load(control, slot);
      if (Atomics.load(control, slots.fault)) throw failedThreads(this.solver.subject, 'stopped during native work');
      if (seen === this.workers.length) return;
      const remaining = limit - performance.now();
      if (remaining <= 0) throw failedThreads(this.solver.subject, failure);
      Atomics.wait(control, slot, seen, remaining);
    }
  }
}

export async function createNativePhasePool(
  threads: number,
  options: NativePhasePoolOptions,
): Promise<NativePhasePool> {
  const { signal, ...solver } = options;
  const { subject } = solver;
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(threads) || threads < 2)
    throw new MargoError(
      'state',
      `Give the ${subject.toLowerCase()} worker pool a whole thread count of at least two.`,
    );
  assertThreadEnvironment(subject);
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const boot = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const workers: ThreadWorker[] = [];
  try {
    for (let i = 1; i < threads; i++) {
      boot.throwIfAborted();
      const worker = await startWorker();
      workers.push(worker);
      await waitForWorkerBoot(worker, boot);
    }
    boot.throwIfAborted();
    return new NativePhasePool(workers, solver);
  } catch (cause) {
    for (const worker of workers) worker.close();
    signal?.throwIfAborted();
    throw failedThreads(subject, 'could not start', cause);
  }
}
