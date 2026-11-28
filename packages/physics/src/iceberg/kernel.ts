import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { icebergError } from './errors.js';

const JOB_BYTES = 24;
const WORK_WORDS = 5;

/** Ice body work executed by one native participant. */
export interface IcebergWorkerWork {
  /** Body rows inspected, including vacant release slots. */
  readonly rows: number;
  /** Rows containing ice when the native stage started. */
  readonly activeRows: number;
  /** Adaptive internal time intervals actually integrated. */
  readonly substeps: number;
  /** Hydrostatic and drag wrench evaluations, including final displacement. */
  readonly wrenchEvaluations: number;
  /** Clipped face triangles whose area uses a two-active-lane f64x2 dot product. */
  readonly pairedPanelDots: number;
}

/** Native work in the last successful integration, with the caller at worker index zero. */
export interface IcebergWorkCounts extends IcebergWorkerWork {
  readonly threads: number;
  readonly workers: readonly IcebergWorkerWork[];
}

export interface IcebergBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

export interface IcebergKernel {
  iceberg_step(state: number, count: number, settings: number, dt: number): number;
  workCounts(): IcebergWorkCounts | undefined;
}

type Arguments = Parameters<IcebergKernel['iceberg_step']>;
type Phase = (job: number, stage: number, part: number, parts: number) => number;

export async function loadIcebergBuilds(signal?: AbortSignal, threads = 1): Promise<IcebergBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw icebergError('Choose 1, 2 or 4 iceberg native participants.', 'unsupported');
  if (threads > 1 && !canShareMemory())
    throw icebergError(
      'Use Node or an isolated browser worker for iceberg helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './iceberg-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './iceberg-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        subject: 'Iceberg',
        phaseExport: 'iceberg_thread_phase',
        phase: 'body hydrodynamics',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw icebergError(
      'Start iceberg helpers in Node or an isolated browser worker, or choose threads: 1.',
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
      throw icebergError(
        `Iceberg Wasm request returned HTTP ${response.status}; serve the iceberg kernel asset.`,
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
    throw icebergError(
      'Iceberg Wasm failed to load; use a SIMD runtime and serve the optional iceberg kernel.',
      'failed',
      cause,
    );
  }
}

function stackTop({ byteOffset, byteLength }: Region): number {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

export function bindIcebergKernel(host: SolverHost, builds: IcebergBuilds): IcebergKernel {
  try {
    return bind(host, builds);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#iceberg')) throw cause;
    throw icebergError('Bind iceberg Wasm and helpers in a compatible world, or choose threads: 1.', 'failed', cause);
  }
}

function bind(host: SolverHost, builds: IcebergBuilds): IcebergKernel {
  const pool = builds.pool;
  const wasm = isShared(host.memory) ? builds.shared : builds.plain;
  if (!wasm)
    throw icebergError(
      pool
        ? 'Use shared world memory for iceberg helpers, or choose threads: 1.'
        : 'The shared iceberg kernel is unavailable; create a plain-memory world.',
      'unsupported',
    );

  const stack = host.allocate('iceberg-kernel-stack', STACK_BYTES + 8, 'u8', 1);
  const threads = pool?.count ?? 1;
  const region = host.allocate('iceberg-native-job', JOB_BYTES + 8 * WORK_WORDS * threads, 'u8', 1);
  const job = region.byteOffset;
  const work = job + JOB_BYTES;
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const { __stack_pointer: pointer, iceberg_step, iceberg_thread_phase } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    typeof iceberg_step !== 'function' ||
    typeof iceberg_thread_phase !== 'function'
  )
    throw icebergError('Rebuild the iceberg Wasm with its body integration exports.', 'failed');
  pointer.value = stackTop(stack);
  const step = iceberg_step as (...args: [...Arguments, work: number]) => number;
  const phase = iceberg_thread_phase as Phase;
  if (pool) {
    const control = host.allocate('iceberg-native-control', 4 * pool.controlWords, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`iceberg-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory: host.memory, module: wasm, job, control: control.byteOffset, stackTops });
  }

  const accepted = new Float64Array(WORK_WORDS * threads);
  return {
    iceberg_step(...args) {
      const buffer = host.memory.buffer;
      let status: number;
      if (pool) {
        new Uint32Array(buffer, job, 4).set([args[0], args[1], args[2], work]);
        new Float64Array(buffer, job + 16, 1)[0] = args[3];
        try {
          status = pool.phase(0, () => phase(job, 0, 0, threads));
        } catch (cause) {
          throw icebergError('Run matching iceberg helpers and Wasm, or choose threads: 1.', 'failed', cause);
        }
      } else {
        status = step(...args, work);
      }
      if (status === 0) accepted.set(new Float64Array(buffer, work, accepted.length));
      return status;
    },
    workCounts() {
      const totals = { rows: 0, activeRows: 0, substeps: 0, wrenchEvaluations: 0, pairedPanelDots: 0 };
      const workers = Array.from({ length: threads }, (_, part) => {
        const at = part * WORK_WORDS;
        const rows = accepted[at]!;
        const activeRows = accepted[at + 1]!;
        const substeps = accepted[at + 2]!;
        const wrenchEvaluations = accepted[at + 3]!;
        const pairedPanelDots = accepted[at + 4]!;
        totals.rows += rows;
        totals.activeRows += activeRows;
        totals.substeps += substeps;
        totals.wrenchEvaluations += wrenchEvaluations;
        totals.pairedPanelDots += pairedPanelDots;
        return { rows, activeRows, substeps, wrenchEvaluations, pairedPanelDots };
      });
      return totals.rows ? { threads, ...totals, workers } : undefined;
    },
  };
}
