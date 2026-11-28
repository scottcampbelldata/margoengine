import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { pedestrianError } from './errors.js';

const JOB_BYTES = 56;
const WORK_WORDS = 5;
const WORK_FIELDS = ['driven', 'wallChecks', 'wallContacts', 'integrated', 'pairedDots'] as const;

export interface PedestrianKernelBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  readonly threads: 1 | 2 | 4;
  [Symbol.dispose](): void;
}

/** Accepted independent drive and integration work performed by one native participant. */
export interface PedestrianWorkerWork {
  readonly driven: number;
  readonly wallChecks: number;
  /** Wall candidates that applied positive normal impulse. */
  readonly wallContacts: number;
  readonly integrated: number;
  /** Two-component SIMD dot products from the independent drive and wall integration passes. */
  readonly pairedDots: number;
}

/** Work in the most recent accepted simulation step. The caller is participant zero. */
export interface PedestrianWorkCounts extends PedestrianWorkerWork {
  readonly threads: number;
  readonly workers: readonly PedestrianWorkerWork[];
}

type PedestrianStep = (
  before: number,
  profile: number,
  command: number,
  walls: number,
  wallCount: number,
  gates: number,
  gateCount: number,
  settings: number,
  after: number,
  grid: number,
  count: number,
  dt: number,
) => number;

export interface PedestrianKernel {
  run: PedestrianStep;
  accept(): void;
  workCounts(): PedestrianWorkCounts | undefined;
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const name = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
      const module = await WebAssembly.compile(await readFile(url, { signal }));
      signal?.throwIfAborted();
      return module;
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw pedestrianError(`Pedestrian Wasm returned HTTP ${response.status}. Serve its optional asset.`, 'failed');
    const module =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/wasm'
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw pedestrianError('Load the pedestrian Wasm asset on a runtime that supports SIMD.', 'failed', cause);
  }
}

export async function loadPedestrianKernel(
  signal?: AbortSignal,
  threads: 1 | 2 | 4 = 1,
): Promise<PedestrianKernelBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw pedestrianError('Choose 1, 2 or 4 native pedestrian participants.', 'unsupported');
  const share = canShareMemory();
  if (threads > 1 && !share)
    throw pedestrianError(
      'Use Node or an isolated browser worker for pedestrian helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './pedestrian-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    share
      ? compile(new URL(/* @vite-ignore */ './pedestrian-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  let pool: NativePhasePool | undefined;
  const close = () => {
    signal?.removeEventListener('abort', close);
    pool?.close();
  };
  try {
    if (threads > 1) {
      pool = await createNativePhasePool(threads, {
        subject: 'Pedestrians',
        phaseExport: 'pedestrian_thread_phase',
        phase: 'walker drive and wall integration',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, threads, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw pedestrianError(
      'Start pedestrian helpers in Node or an isolated browser worker, or choose threads: 1.',
      cause instanceof MargoError ? cause.code : 'failed',
      cause,
    );
  }
}

function stackTop({ byteOffset, byteLength }: Region): number {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

export function instantiatePedestrianKernel(host: SolverHost, builds: PedestrianKernelBuilds): PedestrianKernel {
  try {
    return bind(host, builds);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#pedestrians')) throw cause;
    throw pedestrianError(
      'Bind pedestrian Wasm and helpers in a compatible world, or choose threads: 1.',
      'failed',
      cause,
    );
  }
}

function bind(host: SolverHost, { pool, threads, shared, plain }: PedestrianKernelBuilds): PedestrianKernel {
  const { memory } = host;
  const module = isShared(memory) ? shared : plain;
  if (!module)
    throw pedestrianError(
      pool
        ? 'Use shared world memory for pedestrian helpers, or choose threads: 1.'
        : 'The shared pedestrian kernel is unavailable. Use plain world memory on this host.',
      'unsupported',
    );
  const stack = host.allocate('pedestrian-native-stack', STACK_BYTES + 8, 'u8', 1);
  const job = host.allocate('pedestrian-native-job', JOB_BYTES + 8 * WORK_WORDS * threads, 'f64', 1).byteOffset;
  const work = job + JOB_BYTES;
  const { exports } = new WebAssembly.Instance(module, { env: { memory } });
  const {
    __stack_pointer: pointer,
    pedestrian_prepare: prepare,
    pedestrian_pairs: pairs,
    pedestrian_thread_phase: phase,
  } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    typeof prepare !== 'function' ||
    typeof pairs !== 'function' ||
    typeof phase !== 'function'
  )
    throw pedestrianError(
      'Rebuild both pedestrian Wasm variants with the preparation, pair and worker exports.',
      'version',
    );
  pointer.value = stackTop(stack);
  if (pool) {
    const control = host.allocate('pedestrian-native-control', 4 * pool.controlWords, 'i32', 1).byteOffset;
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`pedestrian-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory, module, job, control, stackTops });
  }

  const step = phase as (job: number, stage: number, part: number, parts: number) => number;
  const dispatch = (stage: number) => {
    const own = () => step(job, stage, 0, threads);
    return pool ? pool.phase(stage, own) : own();
  };
  const accepted = new Float64Array(WORK_WORDS * threads);
  let ready = false;
  let hasAccepted = false;
  return {
    run(before, profile, commands, walls, wallCount, gates, gateCount, settings, after, grid, count, dt) {
      ready = false;
      if (!Number.isSafeInteger(count * (9 * wallCount + 2)))
        throw pedestrianError('Use fewer pedestrians or wall segments to keep native work counts representable.');
      new Uint32Array(memory.buffer, job, 12).set([
        before,
        profile,
        commands,
        walls,
        wallCount,
        gates,
        gateCount,
        settings,
        after,
        grid,
        count,
        work,
      ]);
      new Float64Array(memory.buffer, job + 48, 1)[0] = dt;
      let status: number;
      try {
        status = (prepare(job) as number) || dispatch(0);
        if (!status) {
          pairs(job);
          status = dispatch(1);
        }
      } catch (cause) {
        throw pedestrianError('Run compatible pedestrian Wasm and helpers, or choose threads: 1.', 'failed', cause);
      }
      ready = status === 0;
      return status;
    },
    accept() {
      if (!ready) throw pedestrianError('Run a successful pedestrian step before accepting its work.');
      accepted.set(new Float64Array(memory.buffer, work, accepted.length));
      hasAccepted = true;
      ready = false;
    },
    workCounts() {
      if (!hasAccepted) return undefined;
      const totals = { driven: 0, wallChecks: 0, wallContacts: 0, integrated: 0, pairedDots: 0 };
      const workers = Array.from({ length: threads }, (_, worker) => {
        const row = { ...totals };
        for (const [column, key] of WORK_FIELDS.entries()) {
          row[key] = accepted[worker * WORK_WORDS + column]!;
          totals[key] += row[key];
        }
        return row;
      });
      return { threads, workers, ...totals };
    },
  };
}
