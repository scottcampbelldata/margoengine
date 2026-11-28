import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { thermalError } from './errors.js';

const JOB_BYTES = 56;
const WORK_WORDS = 4;

/** Explicit heat equation work completed by one native participant in the last step. */
export interface ThermalWorkerWork {
  readonly decodedCells: number;
  readonly pairedDecodeCells: number;
  readonly stencilCells: number;
  readonly pairedStencilCells: number;
}

/** Native explicit step work, with the calling thread at worker index zero. */
export interface ThermalWorkCounts extends ThermalWorkerWork {
  readonly threads: number;
  readonly substeps: number;
  readonly workers: readonly ThermalWorkerWork[];
}

export interface ThermalKernelBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

type Decode = (energy: number, temperature: number, liquid: number, coefficients: number, count: number) => void;
type Step = (
  energy: number,
  temperature: number,
  liquid: number,
  coefficients: number,
  scratch: number,
  source: number,
  radiation: number,
  radiators: number,
  nx: number,
  ny: number,
  nz: number,
  subdivisions: number,
  dt: number,
  implicit: number,
) => number;

export interface ThermalConductionKernel {
  readonly thermal_decode: Decode;
  readonly thermal_step: Step;
  workCounts(): ThermalWorkCounts | undefined;
}

type Phase = (job: number, stage: number, part: number, parts: number) => number;
type SerialPhase = (job: number) => number;

/** Compiles thermal builds and optionally starts explicit-conduction helpers, independently of a world. */
export async function loadThermalKernel(signal?: AbortSignal, threads = 1): Promise<ThermalKernelBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw thermalError('Choose 1, 2 or 4 native thermal participants.', 'unsupported');
  const share = canShareMemory();
  if (threads > 1 && !share)
    throw thermalError(
      'Use Node or an isolated browser worker for thermal helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compileThermalAsset(new URL(/* @vite-ignore */ './thermal-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    share
      ? compileThermalAsset(
          new URL(/* @vite-ignore */ './thermal-kernel-shared.wasm?no-inline', import.meta.url),
          signal,
        )
      : undefined,
  ]);
  let pool: NativePhasePool | undefined;
  function close() {
    signal?.removeEventListener('abort', close);
    pool?.close();
  }
  try {
    if (threads > 1) {
      pool = await createNativePhasePool(threads, {
        subject: 'Heat conduction',
        phaseExport: 'thermal_thread_phase',
        phase: 'enthalpy decode and conduction stencil',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw thermalError(
      'Start thermal helpers in Node or an isolated browser worker, or choose threads: 1.',
      'failed',
      cause,
    );
  }
}

function stackTop({ byteOffset, byteLength }: Region): number {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

function instantiate(host: SolverHost, builds: ThermalKernelBuilds) {
  const shared =
    isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]';
  const module = shared ? builds.shared : builds.plain;
  if (!module)
    throw thermalError(
      builds.pool
        ? 'Use shared world memory for thermal helpers, or choose threads: 1.'
        : 'The shared thermal kernel is unavailable. Use plain world memory on this host.',
      'unsupported',
    );
  const stack = host.allocate('thermal-kernel-stack', STACK_BYTES + 8, 'u8', 1);
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  const pointer = exports.__stack_pointer;
  if (!(pointer instanceof WebAssembly.Global))
    throw thermalError('The thermal kernel has no stack pointer. Rebuild the thermal Wasm assets.', 'failed');
  pointer.value = stackTop(stack);
  return { exports, module };
}

/** Binds the matching compiled thermoelasticity build and provides its world-arena stack. */
export function instantiateThermalKernel(host: SolverHost, builds: ThermalKernelBuilds): WebAssembly.Exports {
  return instantiate(host, builds).exports;
}

export function bindThermalConduction(
  host: SolverHost,
  builds: ThermalKernelBuilds,
  implicit: boolean,
): ThermalConductionKernel {
  try {
    return bindConduction(host, builds, implicit);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#thermal')) throw cause;
    throw thermalError('Bind thermal Wasm and helpers in a compatible world, or choose threads: 1.', 'failed', cause);
  }
}

function bindConduction(host: SolverHost, builds: ThermalKernelBuilds, implicit: boolean): ThermalConductionKernel {
  const pool = builds.pool;
  if (implicit && pool)
    throw thermalError(
      'Choose explicit conduction for multiple thermal participants, or use threads: 1 for backward Euler.',
      'unsupported',
    );
  const { exports, module } = instantiate(host, builds);
  const { thermal_decode: decode, thermal_step: step } = exports;
  if (typeof decode !== 'function' || typeof step !== 'function')
    throw thermalError('Rebuild the thermal Wasm with the conduction exports.', 'failed');
  const thermal_decode = decode as Decode;
  if (implicit) return { thermal_decode, thermal_step: step as Step, workCounts: () => undefined };

  const {
    thermal_thread_phase: phaseExport,
    thermal_thread_radiation: radiationExport,
    thermal_thread_finish: finishExport,
  } = exports;
  if (typeof phaseExport !== 'function' || typeof radiationExport !== 'function' || typeof finishExport !== 'function')
    throw thermalError('Rebuild the thermal Wasm with the explicit conduction phases.', 'failed');
  const phase = phaseExport as Phase;
  const radiate = radiationExport as SerialPhase;
  const finish = finishExport as SerialPhase;
  const threads = pool?.count ?? 1;
  const job = host.allocate('thermal-conduction-job', JOB_BYTES + 8 * WORK_WORDS * threads, 'u8', 1).byteOffset;
  const work = job + JOB_BYTES;
  if (pool) {
    const control = host.allocate('thermal-worker-control', 4 * pool.controlWords, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`thermal-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory: host.memory, module, job, control: control.byteOffset, stackTops });
  }

  const accepted = new Float64Array(WORK_WORDS * threads);
  let substeps = 0;
  function run(stage: number) {
    const caller = () => phase(job, stage, 0, threads);
    return pool ? pool.phase(stage, caller) : caller();
  }
  function advance(steps: number, radiators: number) {
    if (run(0) !== 0) return 1;
    for (let sub = 0; sub < steps; sub++) {
      if (run(1) !== 0 || (radiators > 0 && radiate(job) !== 0) || run(2) !== 0) return 1;
    }
    return run(1) || finish(job);
  }

  return {
    thermal_decode,
    thermal_step(
      energy,
      temperature,
      liquid,
      coeff,
      scratch,
      source,
      radiation,
      radiators,
      nx,
      ny,
      nz,
      steps,
      dt,
      mode,
    ) {
      if (mode !== 0 || !Number.isInteger(steps) || steps < 1 || steps > 0xffff_ffff) return 1;
      const buffer = host.memory.buffer;
      new Uint32Array(buffer, job, 12).set([
        energy,
        temperature,
        liquid,
        coeff,
        scratch,
        source,
        radiation,
        radiators,
        nx,
        ny,
        nz,
        work,
      ]);
      new Float64Array(buffer, job + 48, 1)[0] = dt;
      try {
        const status = advance(steps, radiators);
        if (status !== 0) return status;
      } catch (cause) {
        throw thermalError('Run matching thermal helpers and Wasm, or choose threads: 1.', 'failed', cause);
      }
      accepted.set(new Float64Array(buffer, work, accepted.length));
      substeps = steps;
      return 0;
    },
    workCounts() {
      if (substeps === 0) return undefined;
      const totals: { -readonly [Key in keyof ThermalWorkerWork]: number } = {
        decodedCells: 0,
        pairedDecodeCells: 0,
        stencilCells: 0,
        pairedStencilCells: 0,
      };
      const workers = Array.from({ length: threads }, (_, i) => {
        const k = i * WORK_WORDS;
        const row = {
          decodedCells: accepted[k]!,
          pairedDecodeCells: accepted[k + 1]!,
          stencilCells: accepted[k + 2]!,
          pairedStencilCells: accepted[k + 3]!,
        };
        totals.decodedCells += row.decodedCells;
        totals.pairedDecodeCells += row.pairedDecodeCells;
        totals.stencilCells += row.stencilCells;
        totals.pairedStencilCells += row.pairedStencilCells;
        return row;
      });
      return { threads, substeps, ...totals, workers };
    },
  };
}

async function compileThermalAsset(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const nodeFs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ nodeFs);
      const bytes = await readFile(url, { signal });
      signal?.throwIfAborted();
      const module = await WebAssembly.compile(bytes);
      signal?.throwIfAborted();
      return module;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw thermalError(
        `Thermal kernel request returned HTTP ${response.status}. Serve the thermal Wasm asset.`,
        'failed',
      );
    const module =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw thermalError(
      'Thermal Wasm failed to load. Use a SIMD-capable runtime and serve the thermal Wasm asset.',
      'failed',
      cause,
    );
  }
}
