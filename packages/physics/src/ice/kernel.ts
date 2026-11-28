import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { iceError } from './errors.js';

const STAGED_WORDS = 9;
const RESULT_WORDS = 4;
const WORK_WORDS = 2;
const JOB_BYTES = 24;

/** Physical site rows processed by one participant in the phase-energy balance. */
export interface IceWorkerWork {
  readonly sites: number;
  /** Sites for which both lanes of the f64x2 balance were used. */
  readonly pairedSites: number;
}

/** Phase-energy work from the most recent accepted step, with the caller at index zero. */
export interface IceWorkCounts extends IceWorkerWork {
  readonly threads: number;
  readonly workers: readonly IceWorkerWork[];
}

export interface IceBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

export interface IceKernel {
  /** Current private bank of nine-word site inputs. Reacquire after world-memory growth. */
  rows(): Float64Array;
  /** Run the phase-energy balance and read the four-word output rows from this step's private bank. */
  apply(dt: number): Float64Array;
  workCounts(): IceWorkCounts | undefined;
}

type Phase = (job: number, stage: number, part: number, parts: number) => number;

export async function loadIceBuilds(signal?: AbortSignal, threads = 1): Promise<IceBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw iceError('Choose 1, 2 or 4 ice thermodynamics native participants.', 'unsupported');
  if (threads > 1 && !canShareMemory())
    throw iceError('Use Node or an isolated browser worker for ice helpers, or choose threads: 1.', 'unsupported');
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './ice-thermal-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './ice-thermal-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        subject: 'Ice thermodynamics',
        phaseExport: 'ice_thermal_thread_phase',
        phase: 'phase energy',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw iceError('Start ice helpers in Node or an isolated browser worker, or choose threads: 1.', 'failed', cause);
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
      throw iceError(
        `Ice Wasm request returned HTTP ${response.status}. Serve the ice thermal kernel asset.`,
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
    throw iceError(
      'Ice Wasm failed to load. Use a SIMD runtime and serve the optional ice thermal kernel.',
      'failed',
      cause,
    );
  }
}

function stackTop({ byteOffset, byteLength }: Region): number {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

export function bindIceKernel(host: SolverHost, builds: IceBuilds, count: number): IceKernel {
  try {
    return bind(host, builds, count);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#ice-thermal')) throw cause;
    throw iceError('Bind ice Wasm and helpers in a compatible world, or choose threads: 1.', 'failed', cause);
  }
}

function bind(host: SolverHost, builds: IceBuilds, count: number): IceKernel {
  const pool = builds.pool;
  const shared =
    isShared(host.memory) || Object.prototype.toString.call(host.memory.buffer) === '[object SharedArrayBuffer]';
  const wasm = shared ? builds.shared : builds.plain;
  if (!wasm)
    throw iceError(
      pool
        ? 'Use shared world memory for ice helpers, or choose threads: 1.'
        : 'Shared ice Wasm is unavailable. Choose plain world memory.',
      'unsupported',
    );
  if (!Number.isInteger(count) || count < 1 || count > Math.floor(0x7fff_ffff / (8 * STAGED_WORDS)))
    throw iceError('Reduce the number of ice sites to fit the native phase-energy bank.', 'unsupported');

  const threads = pool?.count ?? 1;
  const stack = host.allocate('ice-thermal-stack', STACK_BYTES + 8, 'u8', 1);
  const job = host.allocate('ice-thermal-job', JOB_BYTES + 4 * WORK_WORDS * threads, 'u8', 1).byteOffset;
  const work = job + JOB_BYTES;
  const input = host.allocate('ice-thermal-input', 8 * STAGED_WORDS * count, 'f64', 1).byteOffset;
  const output = host.allocate('ice-thermal-output', 8 * RESULT_WORDS * count, 'f64', 1).byteOffset;
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const { __stack_pointer: pointer, __data_end: dataEnd, ice_thermal_thread_phase } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    !(dataEnd instanceof WebAssembly.Global) ||
    dataEnd.value !== 0 ||
    typeof ice_thermal_thread_phase !== 'function'
  )
    throw iceError('Rebuild the slot-free ice Wasm with its phase energy export.', 'failed');
  pointer.value = stackTop(stack);
  const phase = ice_thermal_thread_phase as Phase;

  if (pool) {
    const control = host.allocate('ice-thermal-control', 4 * pool.controlWords, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`ice-thermal-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory: host.memory, module: wasm, job, control: control.byteOffset, stackTops });
  }

  const accepted = new Uint32Array(WORK_WORDS * threads);
  return {
    rows: () => new Float64Array(host.memory.buffer, input, STAGED_WORDS * count),
    apply(dt) {
      const buffer = host.memory.buffer;
      new Uint32Array(buffer, job, 4).set([input, output, work, count]);
      new Float64Array(buffer, job + 16, 1)[0] = dt;
      const own = () => phase(job, 0, 0, threads);
      let status: number;
      try {
        status = pool ? pool.phase(0, own) : own();
      } catch (cause) {
        throw iceError('Run matching ice helpers and Wasm, or choose threads: 1.', 'failed', cause);
      }
      if (status !== 0)
        throw iceError('Ice phase energy exceeds its numerical range. Reduce the boundary flux or site dimensions.');
      accepted.set(new Uint32Array(buffer, work, accepted.length));
      return new Float64Array(buffer, output, RESULT_WORDS * count);
    },
    workCounts() {
      if (!accepted.some((value) => value > 0)) return undefined;
      let sites = 0;
      let pairedSites = 0;
      const workers = Array.from({ length: threads }, (_, i) => {
        const at = i * WORK_WORDS;
        const row = { sites: accepted[at]!, pairedSites: accepted[at + 1]! };
        sites += row.sites;
        pairedSites += row.pairedSites;
        return row;
      });
      return { threads, sites, pairedSites, workers };
    },
  };
}
