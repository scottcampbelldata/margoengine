import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { strandError } from './errors.js';

const JOB_WORDS = 7;
const WORK_WORDS = 4;

export interface StrandKernelBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  readonly threads: 1 | 2 | 4;
  [Symbol.dispose](): void;
}

/** Work performed by one native participant in the last accepted substep. */
export interface StrandWorkerWork {
  /** Point states copied for ordered projection and velocity reconstruction. */
  readonly points: number;
  /** Unpinned points evaluated for gravity and air drag. */
  readonly movingPoints: number;
  /** Point frames evaluated using damped angular velocity. */
  readonly spinningPoints: number;
  /** Points evaluated by the two-point SIMD translation path. */
  readonly pairedMovingPoints: number;
}

/** Native prediction work for the last accepted substep. The caller is participant zero. */
export interface StrandWorkCounts extends StrandWorkerWork {
  readonly threads: number;
  readonly workers: readonly StrandWorkerWork[];
}

export interface StrandPrediction {
  run(): void;
  accept(): void;
  workCounts(): StrandWorkCounts | undefined;
}

const BANKS = ['nodes', 'material', 'environment', 'scratch', 'config'] as const;
type PredictionRegions = Readonly<Record<(typeof BANKS)[number], Region>>;

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      const module = await WebAssembly.compile(await readFile(url, { signal }));
      signal?.throwIfAborted();
      return module;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw strandError(`Strand Wasm returned HTTP ${response.status}. Serve its optional assets.`, 'failed');
    const module =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw strandError('Load both strand Wasm variants on a runtime that supports SIMD.', 'failed', cause);
  }
}

export async function loadStrandKernels(signal?: AbortSignal, threads: 1 | 2 | 4 = 1): Promise<StrandKernelBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw strandError('Choose 1, 2 or 4 native strand participants.', 'unsupported');
  const share = canShareMemory();
  if (threads > 1 && !share)
    throw strandError(
      'Use Node or an isolated browser worker for strand helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './strand-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    share
      ? compile(new URL(/* @vite-ignore */ './strand-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        subject: 'Strands',
        phaseExport: 'strand_predict_phase',
        phase: 'point prediction',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, threads, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw strandError(
      'Start strand helpers in Node or an isolated browser worker, or choose threads: 1.',
      cause instanceof MargoError ? cause.code : 'failed',
      cause,
    );
  }
}

export function bindStrandPrediction(
  host: SolverHost,
  { pool, threads }: StrandKernelBuilds,
  module: WebAssembly.Module,
  instance: WebAssembly.Instance,
  regions: PredictionRegions,
  count: number,
): StrandPrediction {
  const { memory } = host;
  const lengths = [13 * count, 13 * count, 8 * count, 25 * count, 10];
  if (
    !Number.isSafeInteger(count) ||
    count < 2 ||
    200 * count > 0x7fff_ffff ||
    BANKS.some((name, i) => {
      const region = regions[name];
      return (
        (region.memory ?? memory) !== memory ||
        region.layout !== 1 ||
        region.type !== 'f64' ||
        region.byteOffset % 8 !== 0 ||
        region.byteLength !== 8 * lengths[i]!
      );
    })
  )
    throw strandError('Allocate matching world-owned layout-1 f64 strand prediction banks.', 'version');

  const { strand_predict_phase: phase, __data_end: dataEnd } = instance.exports;
  if (typeof phase !== 'function' || !(dataEnd instanceof WebAssembly.Global) || dataEnd.value !== 0)
    throw strandError('Rebuild both slot-free strand Wasm variants with their point-prediction export.', 'version');
  if (pool && !isShared(memory))
    throw strandError('Use shared world memory for strand helpers, or choose threads: 1.', 'unsupported');

  const job = host.allocate('strand-prediction-job', 4 * (JOB_WORDS + WORK_WORDS * threads), 'i32', 1).byteOffset;
  const work = job + 4 * JOB_WORDS;
  new Uint32Array(memory.buffer, job, JOB_WORDS).set([...BANKS.map((name) => regions[name].byteOffset), count, work]);
  if (pool) {
    const control = host.allocate('strand-prediction-control', 4 * pool.controlWords, 'i32', 1).byteOffset;
    const stackTops = Array.from({ length: threads - 1 }, (_, i) => {
      const { byteOffset, byteLength } = host.allocate(`strand-prediction-stack-${i}`, STACK_BYTES + 8, 'u8', 1);
      return Math.floor((byteOffset + byteLength) / 16) * 16;
    });
    try {
      pool.init({ memory, module, job, control, stackTops });
    } catch (cause) {
      pool.close();
      throw strandError('Bind strand helpers to one shared world, or choose threads: 1.', 'failed', cause);
    }
  }

  let ready = false;
  let hasAccepted = false;
  const accepted = new Uint32Array(WORK_WORDS * threads);
  const own = () => phase(job, 0, 0, threads) as number;
  return {
    run() {
      ready = false;
      let status: number;
      try {
        status = pool ? pool.phase(0, own) : own();
      } catch (cause) {
        throw strandError('Run compatible strand Wasm and helpers, or choose threads: 1.', 'failed', cause);
      }
      if (status !== 0)
        throw strandError('Reduce strand velocity or forcing, or shorten the substep to keep point prediction finite.');
      ready = true;
    },
    accept() {
      if (!ready) throw strandError('Run a successful strand prediction before accepting its work.');
      accepted.set(new Uint32Array(memory.buffer, work, accepted.length));
      ready = false;
      hasAccepted = true;
    },
    workCounts() {
      if (!hasAccepted) return undefined;
      const workers = Array.from({ length: threads }, (_, i) => {
        const offset = i * WORK_WORDS;
        return {
          points: accepted[offset]!,
          movingPoints: accepted[offset + 1]!,
          spinningPoints: accepted[offset + 2]!,
          pairedMovingPoints: accepted[offset + 3]!,
        };
      });
      const total = (field: keyof StrandWorkerWork) => workers.reduce((sum, worker) => sum + worker[field], 0);
      return {
        threads,
        points: total('points'),
        movingPoints: total('movingPoints'),
        spinningPoints: total('spinningPoints'),
        pairedMovingPoints: total('pairedMovingPoints'),
        workers,
      };
    },
  };
}
