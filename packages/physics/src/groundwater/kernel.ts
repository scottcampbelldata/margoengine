import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { groundwaterError } from './errors.js';

const JOB_BYTES = 80;
const WORK_WORDS = 4;

/** Aquifer assembly work completed by one native participant. */
export interface GroundwaterWorkerWork {
  /** Cell rows initialized from accepted aquifer depth and recharge. */
  readonly cells: number;
  /** In-grid face conductances evaluated, including impermeable interfaces. */
  readonly faceConductances: number;
  /** Face conductances evaluated with both east and south f64x2 lanes. */
  readonly pairedFaceConductances: number;
  /** Drains above their opening threshold when the active-set solve began. */
  readonly initialActiveSprings: number;
}

/** Assembly work in the latest successful groundwater step, including the caller at index zero. */
export interface GroundwaterWorkCounts extends GroundwaterWorkerWork {
  readonly threads: number;
  readonly workers: readonly GroundwaterWorkerWork[];
}

export interface GroundwaterBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

export interface GroundwaterKernel {
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
  workCounts(): GroundwaterWorkCounts | undefined;
}

type Arguments = Parameters<GroundwaterKernel['groundwater_step']>;
type Phase = (job: number, stage: number, part: number, parts: number) => number;

export async function loadGroundwaterBuilds(signal?: AbortSignal, threads = 1): Promise<GroundwaterBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw groundwaterError('Choose 1, 2 or 4 groundwater native participants.', 'unsupported');
  if (threads > 1 && !canShareMemory())
    throw groundwaterError(
      'Use Node or an isolated browser worker for groundwater helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './groundwater-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './groundwater-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        subject: 'Groundwater',
        phaseExport: 'groundwater_thread_phase',
        phase: 'aquifer conductance',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw groundwaterError(
      'Start groundwater helpers in Node or an isolated browser worker, or choose threads: 1.',
      'failed',
      cause,
    );
  }
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const module = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ module);
      const wasm = await WebAssembly.compile(await readFile(url, { signal }));
      signal?.throwIfAborted();
      return wasm;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw groundwaterError(
        `Groundwater Wasm request returned HTTP ${response.status}; serve the groundwater kernel asset.`,
        'failed',
      );
    const wasm =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return wasm;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw groundwaterError(
      'Groundwater Wasm failed to load; use a SIMD runtime and serve the optional groundwater kernel.',
      'failed',
      cause,
    );
  }
}

function stackTop({ byteOffset, byteLength }: Region): number {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

export function bindGroundwaterKernel(host: SolverHost, builds: GroundwaterBuilds): GroundwaterKernel {
  try {
    return bind(host, builds);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#groundwater')) throw cause;
    throw groundwaterError(
      'Bind groundwater Wasm and helpers in a compatible world, or choose threads: 1.',
      'failed',
      cause,
    );
  }
}

function bind(host: SolverHost, builds: GroundwaterBuilds): GroundwaterKernel {
  const pool = builds.pool;
  // Without cross-origin isolation, the browser can still hand out existing Wasm shared memory.
  const shared =
    isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]';
  const wasm = shared ? builds.shared : builds.plain;
  if (!wasm)
    throw groundwaterError(
      pool
        ? 'Use shared world memory for groundwater helpers, or choose threads: 1.'
        : 'Shared groundwater Wasm is unavailable; choose plain world memory.',
      'unsupported',
    );

  const stack = host.allocate('groundwater-stack', STACK_BYTES + 8, 'u8', 1);
  const threads = pool?.count ?? 1;
  const region = host.allocate('groundwater-native-job', JOB_BYTES + 8 * WORK_WORDS * threads, 'u8', 1);
  const job = region.byteOffset;
  const work = job + JOB_BYTES;
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const {
    __stack_pointer: pointer,
    __data_end: dataEnd,
    groundwater_step,
    groundwater_thread_phase,
    groundwater_finish,
  } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    !(dataEnd instanceof WebAssembly.Global) ||
    dataEnd.value !== 0 ||
    typeof groundwater_step !== 'function' ||
    typeof groundwater_thread_phase !== 'function' ||
    typeof groundwater_finish !== 'function'
  )
    throw groundwaterError('Rebuild the slot-free groundwater Wasm with its assembly and solve exports.', 'failed');
  pointer.value = stackTop(stack);
  const step = groundwater_step as (...args: [...Arguments, receipt: number]) => number;
  const finish = groundwater_finish as (job: number) => number;
  const phase = groundwater_thread_phase as Phase;
  if (pool) {
    const control = host.allocate('groundwater-native-control', 4 * pool.controlWords, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`groundwater-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory: host.memory, module: wasm, job, control: control.byteOffset, stackTops });
  }

  const accepted = new Float64Array(WORK_WORDS * threads);
  return {
    groundwater_step(...args) {
      const buffer = host.memory.buffer;
      let status: number;
      if (pool) {
        const words = new Uint32Array(buffer, job, 10);
        words.set(args.slice(0, 8));
        words[8] = work;
        new Float64Array(buffer, job + 40, 5).set(args.slice(8));
        try {
          status = pool.phase(0, () => phase(job, 0, 0, threads));
          if (status === 0) status = finish(job);
        } catch (cause) {
          throw groundwaterError('Run matching groundwater helpers and Wasm, or choose threads: 1.', 'failed', cause);
        }
      } else {
        status = step(...args, work);
      }
      if (status === 0) accepted.set(new Float64Array(buffer, work, accepted.length));
      return status;
    },
    workCounts() {
      const totals = { cells: 0, faceConductances: 0, pairedFaceConductances: 0, initialActiveSprings: 0 };
      const workers = Array.from({ length: threads }, (_, part) => {
        const at = part * WORK_WORDS;
        const cells = accepted[at]!;
        const faceConductances = accepted[at + 1]!;
        const pairedFaceConductances = accepted[at + 2]!;
        const initialActiveSprings = accepted[at + 3]!;
        totals.cells += cells;
        totals.faceConductances += faceConductances;
        totals.pairedFaceConductances += pairedFaceConductances;
        totals.initialActiveSprings += initialActiveSprings;
        return { cells, faceConductances, pairedFaceConductances, initialActiveSprings };
      });
      return totals.cells ? { threads, ...totals, workers } : undefined;
    },
  };
}
