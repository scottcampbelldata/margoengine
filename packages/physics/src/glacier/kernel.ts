import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { glacierError } from './errors.js';

const JOB_BYTES = 104;
const WORK_WORDS = 5;

/** Shallow-ice and fracture work completed by one native participant. */
export interface GlacierWorkerWork {
  /** Cells examined for east and south shallow-ice conductance. */
  readonly weightsRows: number;
  /** Grounded face weights actually evaluated, including zero weights on level surfaces. */
  readonly faceWeights: number;
  /** Face weights evaluated in a two-active-lane f64x2 operation. */
  readonly pairedFaceWeights: number;
  /** Cells processed by the crevasse and ice-release phase. */
  readonly fractureRows: number;
  /** Nye crevasse roots evaluated for extensional flow. */
  readonly crevasseRoots: number;
}

/** Work from the latest successful update, including the caller at worker index zero. */
export interface GlacierWorkCounts extends GlacierWorkerWork {
  readonly threads: number;
  readonly workers: readonly GlacierWorkerWork[];
}

export interface GlacierBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

export interface GlacierKernel {
  glacier_step(
    state: number,
    data: number,
    work: number,
    drainage: number,
    nx: number,
    nz: number,
    dx: number,
    dz: number,
    gravity: number,
    softness: number,
    iceDensity: number,
    waterDensity: number,
    seaLevel: number,
    seconds: number,
    dt: number,
  ): number;
  workCounts(): GlacierWorkCounts | undefined;
}

type Arguments = Parameters<GlacierKernel['glacier_step']>;
type Phase = (job: number, stage: number, part: number, parts: number) => number;

export async function loadGlacierBuilds(signal?: AbortSignal, threads = 1): Promise<GlacierBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw glacierError('Choose 1, 2 or 4 glacier native participants.', 'unsupported');
  if (threads > 1 && !canShareMemory())
    throw glacierError(
      'Use Node or an isolated browser worker for glacier helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './glacier-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './glacier-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        subject: 'Glacier',
        phaseExport: 'glacier_thread_phase',
        phase: 'flow weights and crevasses',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw glacierError(
      'Start glacier helpers in Node or an isolated browser worker, or choose threads: 1.',
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
      throw glacierError(
        `Glacier Wasm request returned HTTP ${response.status}; serve the glacier kernel asset.`,
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
    throw glacierError(
      'Glacier Wasm failed to load; use a SIMD runtime and serve the optional glacier kernel.',
      'failed',
      cause,
    );
  }
}

function stackTop({ byteOffset, byteLength }: Region): number {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

export function bindGlacierKernel(host: SolverHost, builds: GlacierBuilds): GlacierKernel {
  try {
    return bind(host, builds);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#glacier')) throw cause;
    throw glacierError('Bind glacier Wasm and helpers in a compatible world, or choose threads: 1.', 'failed', cause);
  }
}

function bind(host: SolverHost, builds: GlacierBuilds): GlacierKernel {
  const pool = builds.pool;
  const wasm = isShared(host.memory) ? builds.shared : builds.plain;
  if (!wasm)
    throw glacierError(
      pool
        ? 'Use shared world memory for glacier helpers, or choose threads: 1.'
        : 'The shared glacier kernel is unavailable; create a plain-memory world.',
      'unsupported',
    );

  const stack = host.allocate('glacier-kernel-stack', STACK_BYTES + 8, 'u8', 1);
  const threads = pool?.count ?? 1;
  const region = host.allocate('glacier-native-job', JOB_BYTES + 8 * WORK_WORDS * threads, 'u8', 1);
  const job = region.byteOffset;
  const work = job + JOB_BYTES;
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const { __stack_pointer: pointer, glacier_step, glacier_prepare, glacier_solve, glacier_thread_phase, glacier_finish } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    typeof glacier_step !== 'function' ||
    typeof glacier_prepare !== 'function' ||
    typeof glacier_solve !== 'function' ||
    typeof glacier_thread_phase !== 'function' ||
    typeof glacier_finish !== 'function'
  )
    throw glacierError('Rebuild the glacier Wasm with its flow and fracture exports.', 'failed');
  pointer.value = stackTop(stack);
  const step = glacier_step as (...args: [...Arguments, receipt: number]) => number;
  const prepare = glacier_prepare as (job: number) => number;
  const solve = glacier_solve as (job: number) => number;
  const finish = glacier_finish as (job: number) => number;
  const phase = glacier_thread_phase as Phase;
  if (pool) {
    const control = host.allocate('glacier-native-control', 4 * pool.controlWords, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`glacier-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory: host.memory, module: wasm, job, control: control.byteOffset, stackTops });
  }

  const accepted = new Float64Array(WORK_WORDS * threads);
  return {
    glacier_step(...args) {
      const buffer = host.memory.buffer;
      let status: number;
      if (pool) {
        const words = new Uint32Array(buffer, job, 8);
        words.set(args.slice(0, 6));
        words[6] = work;
        new Float64Array(buffer, job + 32, 9).set(args.slice(6));
        try {
          status = prepare(job);
          if (status === 0) status = pool.phase(0, () => phase(job, 0, 0, threads));
          if (status === 0) status = solve(job);
          if (status === 0) status = pool.phase(1, () => phase(job, 1, 0, threads));
          if (status === 0) status = finish(job);
        } catch (cause) {
          throw glacierError('Run matching glacier helpers and Wasm, or choose threads: 1.', 'failed', cause);
        }
      } else {
        status = step(...args, work);
      }
      if (status === 0) accepted.set(new Float64Array(buffer, work, accepted.length));
      return status;
    },
    workCounts() {
      const totals = { weightsRows: 0, faceWeights: 0, pairedFaceWeights: 0, fractureRows: 0, crevasseRoots: 0 };
      const workers = Array.from({ length: threads }, (_, part) => {
        const at = part * WORK_WORDS;
        const weightsRows = accepted[at]!;
        const faceWeights = accepted[at + 1]!;
        const pairedFaceWeights = accepted[at + 2]!;
        const fractureRows = accepted[at + 3]!;
        const crevasseRoots = accepted[at + 4]!;
        totals.weightsRows += weightsRows;
        totals.faceWeights += faceWeights;
        totals.pairedFaceWeights += pairedFaceWeights;
        totals.fractureRows += fractureRows;
        totals.crevasseRoots += crevasseRoots;
        return { weightsRows, faceWeights, pairedFaceWeights, fractureRows, crevasseRoots };
      });
      return totals.fractureRows ? { threads, ...totals, workers } : undefined;
    },
  };
}
