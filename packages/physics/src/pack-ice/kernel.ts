import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { packIceError } from './errors.js';

const JOB_BYTES = 72;

/** Floe translation and drag work completed by one native participant. */
export interface PackIceWorkerWork {
  readonly dragRows: number;
  /** Rows integrated with both planar f64x2 lanes. */
  readonly pairedRows: number;
}

/** Latest native integration work, including the caller in worker slot zero. */
export interface PackIceWorkCounts extends PackIceWorkerWork {
  readonly threads: number;
  readonly substeps: number;
  /** Floe velocity probes in the ordered initial time-step calculation. */
  readonly cflProbes: number;
  readonly workers: readonly PackIceWorkerWork[];
}

export interface PackIceBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

export interface PackIceKernel {
  pack_ice_step(
    state: number,
    forcing: number,
    count: number,
    vessels: number,
    vesselCount: number,
    settings: number,
    grid: number,
    gridCapacity: number,
    links: number,
    impulses: number,
    stats: number,
    dt: number,
  ): number;
  workCounts(): PackIceWorkCounts | undefined;
}

type Arguments = Parameters<PackIceKernel['pack_ice_step']>;
type Phase = (job: number, stage: number, part: number, parts: number) => number;

export async function loadPackIceBuilds(signal?: AbortSignal, threads = 1): Promise<PackIceBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw packIceError('Choose 1, 2 or 4 pack-ice native participants.', 'unsupported');
  if (threads > 1 && !canShareMemory())
    throw packIceError(
      'Use Node or an isolated browser worker for pack-ice helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './pack-ice-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './pack-ice-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        subject: 'Pack ice',
        phaseExport: 'pack_ice_thread_phase',
        phase: 'planar floe drift',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw packIceError(
      'Start pack-ice helpers in Node or an isolated browser worker, or choose threads: 1.',
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
      throw packIceError(
        `PackIce Wasm request returned HTTP ${response.status}; serve the pack-ice kernel asset.`,
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
    throw packIceError(
      'PackIce Wasm failed to load; use a SIMD runtime and serve the optional pack-ice kernel.',
      'failed',
      cause,
    );
  }
}

function stackTop({ byteOffset, byteLength }: Region): number {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

export function bindPackIceKernel(host: SolverHost, builds: PackIceBuilds): PackIceKernel {
  try {
    return bind(host, builds);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#pack-ice')) throw cause;
    throw packIceError('Bind pack-ice Wasm and helpers in a compatible world, or choose threads: 1.', 'failed', cause);
  }
}

function bind(host: SolverHost, builds: PackIceBuilds): PackIceKernel {
  const pool = builds.pool;
  const wasm = isShared(host.memory) ? builds.shared : builds.plain;
  if (!wasm)
    throw packIceError(
      pool
        ? 'Use shared world memory for pack-ice helpers, or choose threads: 1.'
        : 'The shared pack-ice kernel is unavailable; create a plain-memory world.',
      'unsupported',
    );
  const stack = host.allocate('pack-ice-kernel-stack', STACK_BYTES + 8, 'u8', 1);
  const threads = pool?.count ?? 1;
  const region = host.allocate('pack-ice-native-job', JOB_BYTES + 8 * threads, 'u8', 1);
  const job = region.byteOffset;
  const work = job + JOB_BYTES;
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const {
    __stack_pointer: pointer,
    pack_ice_step,
    pack_ice_prepare,
    pack_ice_thread_phase,
    pack_ice_contacts,
  } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    typeof pack_ice_step !== 'function' ||
    typeof pack_ice_prepare !== 'function' ||
    typeof pack_ice_thread_phase !== 'function' ||
    typeof pack_ice_contacts !== 'function'
  )
    throw packIceError('Rebuild the optional pack-ice Wasm with its preparation, drift and contact stages.', 'failed');
  pointer.value = stackTop(stack);
  const step = pack_ice_step as (...args: [...Arguments, work: number]) => number;
  const prepare = pack_ice_prepare as (job: number) => number;
  const phase = pack_ice_thread_phase as Phase;
  const contacts = pack_ice_contacts as (job: number, generation: number) => number;
  if (pool) {
    const control = host.allocate('pack-ice-native-control', 4 * pool.controlWords, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`pack-ice-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory: host.memory, module: wasm, job, control: control.byteOffset, stackTops });
  }
  const accepted = new Float64Array(threads);
  let substeps = 0;
  let cflProbes = 0;
  return {
    pack_ice_step(...args) {
      const count = args[2];
      const stats = args[10];
      const buffer = host.memory.buffer;
      const counts = new Float64Array(buffer, work, threads);
      let status: number;
      if (pool) {
        const words = new Uint32Array(buffer, job, JOB_BYTES / 4);
        words.set(args.slice(0, 11));
        words[11] = work;
        new Float64Array(buffer, job + 48, 1)[0] = args[11];
        counts.fill(0);
        try {
          status = prepare(job);
          if (status !== 0) return status;
          for (let generation = 1; generation <= words[16]!; generation++) {
            status = pool.phase(0, () => phase(job, 0, 0, threads));
            if (status === 0) status = contacts(job, generation);
            if (status !== 0) return status;
          }
        } catch (cause) {
          throw packIceError('Run matching pack-ice helpers and Wasm, or choose threads: 1.', 'failed', cause);
        }
      } else {
        status = step(...args, work);
        if (status !== 0) return status;
      }
      accepted.set(counts);
      substeps = new Uint32Array(buffer, stats, 1)[0]!;
      cflProbes = count;
      return 0;
    },
    workCounts() {
      if (substeps === 0) return undefined;
      let total = 0;
      const workers = Array.from(accepted, (dragRows) => {
        total += dragRows;
        return { dragRows, pairedRows: dragRows };
      });
      return { threads, substeps, cflProbes, dragRows: total, pairedRows: total, workers };
    },
  };
}
