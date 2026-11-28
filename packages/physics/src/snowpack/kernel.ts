import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { snowpackError } from './errors.js';

const JOB_BYTES = 80;
const WORK_WORDS = 5;

/** Snow-column work completed by one native participant. */
export interface SnowpackWorkerWork {
  /** Grid columns updated after the ordered drifting-snow pass. */
  readonly columns: number;
  /** Column layer rows visited by the initial ice-state scan. */
  readonly layers: number;
  /** Implicit interlayer heat exchanges with a nonzero temperature difference. */
  readonly conductionInterfaces: number;
  /** Heat exchanges computed as one lane of a paired f64x2 solve. */
  readonly pairedInterfaces: number;
  /** Bisection iterations across all physical heat exchanges. */
  readonly bisectionIterations: number;
}

/** Work in the latest native column phase, including the caller at index zero. */
export interface SnowpackWorkCounts extends SnowpackWorkerWork {
  readonly threads: number;
  readonly workers: readonly SnowpackWorkerWork[];
}

export interface SnowpackBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

export interface SnowpackKernel {
  snowpack_step(
    pack: number,
    caps: number,
    drift: number,
    forcing: number,
    viscosity: number,
    cohesion: number,
    oldIce: number,
    config: number,
    runoff: number,
    discharge: number,
    summary: number,
    cover: number,
    width: number,
    depth: number,
    layers: number,
    dt: number,
    worldDt: number,
  ): number;
  workCounts(): SnowpackWorkCounts | undefined;
}

type Arguments = Parameters<SnowpackKernel['snowpack_step']>;
type Phase = (job: number, stage: number, part: number, parts: number) => number;

export async function loadSnowpackBuilds(signal?: AbortSignal, threads = 1): Promise<SnowpackBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw snowpackError('Choose 1, 2 or 4 snowpack native participants.', 'unsupported');
  if (threads > 1 && !canShareMemory())
    throw snowpackError(
      'Use Node or an isolated browser worker for snowpack helpers, or choose threads: 1.',
      'unsupported',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './snowpack-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './snowpack-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        subject: 'Snowpack',
        phaseExport: 'snowpack_thread_phase',
        phase: 'column enthalpy',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw snowpackError(
      'Start snowpack helpers in Node or an isolated browser worker, or choose threads: 1.',
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
      throw snowpackError(
        `Snowpack Wasm request returned HTTP ${response.status}; serve the snowpack kernel asset.`,
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
    throw snowpackError(
      'Snowpack Wasm failed to load; use a SIMD runtime and serve the optional snowpack kernel.',
      'failed',
      cause,
    );
  }
}

function stackTop({ byteOffset, byteLength }: Region): number {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

export function bindSnowpackKernel(host: SolverHost, builds: SnowpackBuilds): SnowpackKernel {
  try {
    return bind(host, builds);
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#snowpack')) throw cause;
    throw snowpackError('Bind snowpack Wasm and helpers in a compatible world, or choose threads: 1.', 'failed', cause);
  }
}


function bind(host: SolverHost, builds: SnowpackBuilds): SnowpackKernel {
  const pool = builds.pool;
  const wasm = isShared(host.memory) ? builds.shared : builds.plain;
  if (!wasm)
    throw snowpackError(
      pool
        ? 'Use shared world memory for snowpack helpers, or choose threads: 1.'
        : 'The shared snowpack kernel is unavailable; create a plain-memory world.',
      'unsupported',
    );

  const stack = host.allocate('snowpack-stack', STACK_BYTES + 8, 'u8', 1);
  const threads = pool?.count ?? 1;
  const region = host.allocate('snowpack-native-job', JOB_BYTES + 8 * WORK_WORDS * threads, 'u8', 1);
  const job = region.byteOffset;
  const work = job + JOB_BYTES;
  const { exports } = new WebAssembly.Instance(wasm, { env: { memory: host.memory } });
  const {
    __stack_pointer: pointer,
    __data_end: dataEnd,
    snowpack_step,
    snowpack_prepare,
    snowpack_thread_phase,
  } = exports;
  if (
    !(pointer instanceof WebAssembly.Global) ||
    !(dataEnd instanceof WebAssembly.Global) ||
    Number(dataEnd.value) !== 0 ||
    typeof snowpack_step !== 'function' ||
    typeof snowpack_prepare !== 'function' ||
    typeof snowpack_thread_phase !== 'function'
  )
    throw snowpackError('Rebuild the slot-free snowpack Wasm with the ordered drift and column stages.', 'failed');
  pointer.value = stackTop(stack);
  const step = snowpack_step as (...args: [...Arguments, work: number]) => number;
  const prepare = snowpack_prepare as (job: number) => number;
  const phase = snowpack_thread_phase as Phase;
  if (pool) {
    const control = host.allocate('snowpack-native-control', 4 * pool.controlWords, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`snowpack-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory: host.memory, module: wasm, job, control: control.byteOffset, stackTops });
  }

  const accepted = new Float64Array(WORK_WORDS * threads);
  return {
    snowpack_step(...args) {
      const buffer = host.memory.buffer;
      let status: number;
      if (pool) {
        const words = new Uint32Array(buffer, job, 16);
        words.set(args.slice(0, 15));
        words[15] = work;
        const times = new Float64Array(buffer, job + 64, 2);
        times[0] = args[15];
        times[1] = args[16];
        try {
          status = prepare(job);
          if (status !== 0) return status;
          status = pool.phase(0, () => phase(job, 0, 0, threads));
        } catch (cause) {
          throw snowpackError('Run matching snowpack helpers and Wasm, or choose threads: 1.', 'failed', cause);
        }
      } else {
        status = step(...args, work);
      }
      if (status === 0) accepted.set(new Float64Array(buffer, work, accepted.length));
      return status;
    },
    workCounts() {
      const totals = { columns: 0, layers: 0, conductionInterfaces: 0, pairedInterfaces: 0, bisectionIterations: 0 };
      const workers = Array.from({ length: threads }, (_, part) => {
        const at = part * WORK_WORDS;
        const columns = accepted[at]!;
        const layers = accepted[at + 1]!;
        const conductionInterfaces = accepted[at + 2]!;
        const pairedInterfaces = accepted[at + 3]!;
        const bisectionIterations = accepted[at + 4]!;
        totals.columns += columns;
        totals.layers += layers;
        totals.conductionInterfaces += conductionInterfaces;
        totals.pairedInterfaces += pairedInterfaces;
        totals.bisectionIterations += bisectionIterations;
        return { columns, layers, conductionInterfaces, pairedInterfaces, bisectionIterations };
      });
      return totals.columns ? { threads, ...totals, workers } : undefined;
    },
  };
}
