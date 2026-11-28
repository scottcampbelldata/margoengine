import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, STACK_BYTES } from '../world/memory.js';
import type { SolverHost } from '../world/solver.js';

const JOB_BYTES = 80;
const WORK_WORDS = 6;

/** Matrix work completed by one native participant during a film step. */
export interface ThinFilmWorkerWork {
  readonly matrixProducts: number;
  readonly transposeRows: number;
  readonly pressureRows: number;
  readonly gradientFaces: number;
  /** Pairs of neighboring pressure cells evaluated in SIMD. */
  readonly pressurePairs: number;
  /** In-plane pairs of outgoing face slots evaluated in SIMD. */
  readonly gradientPairs: number;
}

/** Accepted capillary matrix work, with the caller in worker slot zero. */
export interface ThinFilmWorkCounts extends ThinFilmWorkerWork {
  readonly threads: number;
  readonly workers: readonly ThinFilmWorkerWork[];
}

export interface ThinFilmBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly threaded?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

export interface ThinFilmKernel {
  thin_film_step(
    state: number,
    base: number,
    rain: number,
    drips: number,
    budget: number,
    model: number,
    forcing: number,
    workspace: number,
    nx: number,
    ny: number,
    dt: number,
    wetting: number,
    wettingMap: number,
    contactAngles: number,
    suspended: number,
  ): number;
  workCounts(): ThinFilmWorkCounts;
  [Symbol.dispose](): void;
}

function kernelError(code: 'failed' | 'state' | 'unsupported', message: string, cause?: unknown): MargoError {
  return Object.assign(new MargoError(code, `${message} See https://margoengine.com/errors#thin-film-flow`), { cause });
}

export async function loadThinFilmBuilds(signal?: AbortSignal, threads = 1): Promise<ThinFilmBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw kernelError('state', 'Choose 1, 2 or 4 thin-film participants.');
  if (threads > 1 && !canShareMemory())
    throw kernelError(
      'unsupported',
      'Use an isolated browser worker or Node with shared world memory, or choose threads: 1.',
    );
  const [plain, shared, threaded] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './thin-film-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './thin-film-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
    threads > 1
      ? compile(new URL(/* @vite-ignore */ './thin-film-kernel-threaded.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  let pool: NativePhasePool | undefined;
  function dispose() {
    signal?.removeEventListener('abort', dispose);
    pool?.close();
  }
  try {
    if (threaded) {
      pool = await createNativePhasePool(threads, {
        subject: 'Thin film',
        phaseExport: 'thin_film_thread_phase',
        phase: 'capillary matrix',
        signal,
      });
      signal?.addEventListener('abort', dispose, { once: true });
      signal?.throwIfAborted();
    }
    return { plain, shared, threaded, pool, [Symbol.dispose]: dispose };
  } catch (cause) {
    dispose();
    signal?.throwIfAborted();
    throw kernelError(
      'failed',
      'Start the thin-film helpers in Node or an isolated browser worker, or choose threads: 1.',
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
      throw kernelError(
        'failed',
        `ThinFilm Wasm request returned HTTP ${response.status}; serve the thin-film kernel asset.`,
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
    throw kernelError('failed', 'Use a SIMD runtime and serve the optional thin-film kernel.', cause);
  }
}

function report(words: Float64Array, at: number): ThinFilmWorkerWork {
  return {
    matrixProducts: words[at]!,
    transposeRows: words[at + 1]!,
    pressureRows: words[at + 2]!,
    gradientFaces: words[at + 3]!,
    pressurePairs: words[at + 4]!,
    gradientPairs: words[at + 5]!,
  };
}

function combined(words: Float64Array, threads: number): ThinFilmWorkCounts {
  const workers = Array.from({ length: threads }, (_, i) => report(words, i * WORK_WORDS));
  const total = new Float64Array(WORK_WORDS);
  total[0] = workers[0]!.matrixProducts;
  for (let i = 0; i < threads; i++)
    for (let field = 1; field < WORK_WORDS; field++) total[field]! += words[i * WORK_WORDS + field]!;
  return { ...report(total, 0), threads, workers };
}

type MatrixStep = (...args: [...Parameters<ThinFilmKernel['thin_film_step']>, number]) => number;
type MatrixPhase = (job: number, stage: number, part: number, threads: number) => number;

export function bindThinFilmKernel(host: SolverHost, builds: ThinFilmBuilds): ThinFilmKernel {
  try {
    const shared = typeof SharedArrayBuffer !== 'undefined' && host.memory.buffer instanceof SharedArrayBuffer;
    const pool = builds.pool;
    if (!shared && pool)
      throw kernelError('unsupported', 'Use shared world memory for thin-film workers, or choose threads: 1.');
    const wasm = builds.threaded ?? (shared ? builds.shared : builds.plain);
    if (!wasm)
      throw kernelError('unsupported', 'Load the matching shared thin-film asset or create a plain-memory world.');
    const threads = pool?.count ?? 1;
    const stack = host.allocate('thin-film-kernel-stack', STACK_BYTES, 'u8', 1);
    const lease = host.allocate('thin-film-matrix-job', JOB_BYTES + threads * WORK_WORDS * 8, 'u8', 1);
    const job = lease.byteOffset;
    const receipts = job + JOB_BYTES;
    let phase: MatrixPhase | undefined;
    const { exports } = new WebAssembly.Instance(wasm, {
      env: {
        memory: host.memory,
        thin_film_join(stage: number): void {
          if (!pool || !phase)
            throw kernelError('failed', 'Bind the thin-film worker pool before stepping the threaded kernel.');
          const apply = phase;
          if (pool.phase(stage, () => apply(job, stage, 0, threads)) !== 0)
            throw kernelError('failed', 'Rebuild matching thin-film matrix assets, or choose threads: 1.');
        },
      },
    });
    const pointer = exports.__stack_pointer;
    const raw = exports.thin_film_step;
    const phaseExport = exports.thin_film_thread_phase;
    if (!(pointer instanceof WebAssembly.Global) || typeof raw !== 'function' || typeof phaseExport !== 'function')
      throw kernelError('failed', 'Rebuild the optional thin-film assets with their stack, step and matrix exports.');
    pointer.value = stack.byteOffset + stack.byteLength;
    phase = phaseExport as MatrixPhase;
    const step = raw as MatrixStep;
    if (pool) {
      const module = builds.shared;
      if (!module) throw kernelError('failed', 'Serve the shared thin-film worker Wasm asset.');
      const control = host.allocate('thin-film-matrix-control', pool.controlWords * 4, 'i32', 1);
      const stackTops = Array.from({ length: threads - 1 }, (_, i) => {
        const stack = host.allocate(`thin-film-helper-stack-${i}`, STACK_BYTES, 'u8', 1);
        return stack.byteOffset + stack.byteLength;
      });
      pool.init({ memory: host.memory, module, control: control.byteOffset, job, stackTops });
    }
    const accepted = new Float64Array(threads * WORK_WORDS);
    return {
      thin_film_step(...args) {
        const buffer = host.memory.buffer;
        const work = new Float64Array(buffer, receipts, accepted.length);
        work.fill(0);
        const settings = new Uint32Array(buffer, job, JOB_BYTES / 4);
        settings[8] = receipts;
        settings[11] = threads;
        let status: number;
        try {
          status = step(...args, job);
        } catch (cause) {
          throw kernelError('failed', 'Use matching thin-film workers and Wasm, or choose threads: 1.', cause);
        }
        if (status === 0) accepted.set(work);
        return status;
      },
      workCounts: () => combined(accepted, threads),
      [Symbol.dispose]: () => builds[Symbol.dispose](),
    };
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#thin-film-flow')) throw cause;
    throw kernelError('failed', 'Bind matching thin-film assets to the world or choose threads: 1.', cause);
  }
}
