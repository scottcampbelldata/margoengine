import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { seismicError } from './errors.js';

const JOB_BYTES = 40;
const WORK_WORDS = 4;

/** Physical interior work completed by one participant on the staggered section. */
export interface SeismicWorkerWork {
  /** Cells whose two velocity components were updated. */
  readonly velocityCells: number;
  /** Cells whose three stress components were updated. */
  readonly stressCells: number;
  /** Velocity cells computed with another live f64x2 lane. */
  readonly pairedVelocityCells: number;
  /** Stress cells computed with another live f64x2 lane. */
  readonly pairedStressCells: number;
}

/** Work from the latest successful native step, with the caller at worker index zero. */
export interface SeismicWorkCounts extends SeismicWorkerWork {
  readonly threads: number;
  /** Top velocity points updated by the caller to keep the surface traction-free. */
  readonly surfacePoints: number;
  readonly workers: readonly SeismicWorkerWork[];
}

export interface SeismicBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

export interface SeismicKernel {
  seismic_step(state: number, width: number, depth: number, dx: number, dz: number, dt: number): void;
  workCounts(): SeismicWorkCounts | undefined;
}

type Phase = (job: number, stage: number, part: number, parts: number) => number;

export async function loadSeismicBuilds(signal?: AbortSignal, threads = 1): Promise<SeismicBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw seismicError('Choose 1, 2 or 4 seismic native participants.', 'unsupported');
  if (threads > 1 && !canShareMemory())
    throw seismicError(
      'Use Node or an isolated browser worker for seismic helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './seismic-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './seismic-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        subject: 'Seismic',
        phaseExport: 'seismic_thread_phase',
        phase: 'velocity and stress stencil',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw seismicError(
      'Start seismic helpers in Node or an isolated browser worker, or choose threads: 1.',
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
      throw seismicError(
        `Seismic Wasm request returned HTTP ${response.status}; serve the seismic kernel asset.`,
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
    throw seismicError(
      'Seismic Wasm failed to load; use a SIMD runtime and serve the optional seismic kernel.',
      'failed',
      cause,
    );
  }
}

function stackTop({ byteOffset, byteLength }: Region): number {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

export function bindSeismicKernel(host: SolverHost, builds: SeismicBuilds): SeismicKernel {
  try {
    return bind(host, builds);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#seismic')) throw cause;
    throw seismicError('Bind seismic Wasm and helpers in a compatible world, or choose threads: 1.', 'failed', cause);
  }
}

function bind(host: SolverHost, builds: SeismicBuilds): SeismicKernel {
  const pool = builds.pool;
  // Without cross-origin isolation, the browser can still hand out existing Wasm shared memory.
  const shared =
    isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]';
  const wasm = shared ? builds.shared : builds.plain;
  if (!wasm)
    throw seismicError(
      pool
        ? 'Use shared world memory for seismic helpers, or choose threads: 1.'
        : 'Shared seismic Wasm is unavailable; choose plain world memory.',
      'unsupported',
    );

  const stack = host.allocate('seismic-stack', STACK_BYTES + 8, 'u8', 1);
  const threads = pool?.count ?? 1;
  const region = host.allocate('seismic-native-job', JOB_BYTES + 8 * WORK_WORDS * threads, 'u8', 1);
  const job = region.byteOffset;
  const work = job + JOB_BYTES;
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const { __stack_pointer: pointer, __data_end: dataEnd, seismic_surface, seismic_thread_phase } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    !(dataEnd instanceof WebAssembly.Global) ||
    dataEnd.value !== 0 ||
    typeof seismic_surface !== 'function' ||
    typeof seismic_thread_phase !== 'function'
  )
    throw seismicError('Rebuild the slot-free seismic Wasm with its surface and stencil exports.', 'failed');
  pointer.value = stackTop(stack);
  const surface = seismic_surface as (job: number) => number;
  const phase = seismic_thread_phase as Phase;
  if (pool) {
    const control = host.allocate('seismic-native-control', 4 * pool.controlWords, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`seismic-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory: host.memory, module: wasm, job, control: control.byteOffset, stackTops });
  }

  const accepted = new Float64Array(WORK_WORDS * threads);
  let surfacePoints = 0;
  return {
    seismic_step(state, width, depth, dx, dz, dt) {
      const buffer = host.memory.buffer;
      new Uint32Array(buffer, job, 4).set([state, width, depth, work]);
      new Float64Array(buffer, job + 16, 3).set([dx, dz, dt]);
      let status: number;
      try {
        status = surface(job);
        for (let stage = 0; status === 0 && stage < 2; stage++) {
          const own = () => phase(job, stage, 0, threads);
          status = pool ? pool.phase(stage, own) : own();
        }
      } catch (cause) {
        throw seismicError('Run matching seismic helpers and Wasm, or choose threads: 1.', 'failed', cause);
      }
      if (status !== 0)
        throw seismicError('Use a representable seismic section and matching native stencil configuration.', 'failed');
      accepted.set(new Float64Array(buffer, work, accepted.length));
      surfacePoints = width;
    },
    workCounts() {
      const totals = { velocityCells: 0, stressCells: 0, pairedVelocityCells: 0, pairedStressCells: 0 };
      const workers = Array.from({ length: threads }, (_, part) => {
        const at = part * WORK_WORDS;
        const velocityCells = accepted[at]!;
        const stressCells = accepted[at + 1]!;
        const pairedVelocityCells = accepted[at + 2]!;
        const pairedStressCells = accepted[at + 3]!;
        totals.velocityCells += velocityCells;
        totals.stressCells += stressCells;
        totals.pairedVelocityCells += pairedVelocityCells;
        totals.pairedStressCells += pairedStressCells;
        return { velocityCells, stressCells, pairedVelocityCells, pairedStressCells };
      });
      return surfacePoints ? { threads, surfacePoints, ...totals, workers } : undefined;
    },
  };
}
