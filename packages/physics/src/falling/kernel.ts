import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';

const JOB_BYTES = 40;
const WORK_WORDS = 3;

/** Actual native step-doubling work done by one participant. */
export interface FallingWorkerWork {
  readonly bodies: number;
  readonly rk4Evaluations: number;
  /** f64x2 position, velocity, pitch and span updates in the evaluated RK4 stages. */
  readonly simdStatePairs: number;
}

/** Work for the last accepted body step, with the world caller in participant slot zero. */
export interface FallingWorkCounts extends FallingWorkerWork {
  readonly threads: number;
  readonly workers: readonly FallingWorkerWork[];
}

interface KernelExports extends WebAssembly.Exports {
  __stack_pointer: WebAssembly.Global;
  falling_step(
    models: number,
    sections: number,
    air: number,
    state: number,
    next: number,
    count: number,
    dt: number,
    work: number,
  ): number;
}

export interface FallingBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

type Stage = (job: number, stage: number, part: number, parts: number) => number;

export interface FallingStep {
  run(models: number, sections: number, air: number, state: number, next: number, count: number, dt: number): number;
  workCounts(): FallingWorkCounts;
}

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  let bytes: BufferSource;
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      bytes = await readFile(url, { signal });
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw new MargoError(
          'failed',
          'Falling solver Wasm request failed. Provide its Wasm assets at the expected URL.',
        );
      bytes = await response.arrayBuffer();
    }
    const module = await WebAssembly.compile(bytes);
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(
      new MargoError(
        'failed',
        'Falling solver Wasm failed to load. Use a SIMD-capable runtime and serve its kernel assets.',
      ),
      { cause },
    );
  }
}

export async function loadFallingBuilds(signal?: AbortSignal, threads = 1): Promise<FallingBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw new MargoError('unsupported', 'Choose 1, 2 or 4 falling-body native participants.');
  if (threads > 1 && !canShareMemory())
    throw new MargoError(
      'unsupported',
      'Use Node or an isolated browser worker for falling bodies, or choose threads: 1.',
    );
  const [plain, shared] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './falling-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './falling-kernel-shared.wasm?no-inline', import.meta.url), signal)
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
        subject: 'Falling bodies',
        phaseExport: 'falling_thread_phase',
        phase: 'Runge–Kutta flight',
        signal,
      });
      signal?.addEventListener('abort', close, { once: true });
    }
    signal?.throwIfAborted();
    return { plain, shared, pool, [Symbol.dispose]: close };
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw cause;
  }
}

function stackTop({ byteOffset, byteLength }: Region): number {
  return Math.floor((byteOffset + byteLength) / 16) * 16;
}

function workAt(receipt: Float64Array, at: number): FallingWorkerWork {
  return { bodies: receipt[at]!, rk4Evaluations: receipt[at + 1]!, simdStatePairs: receipt[at + 2]! };
}

export function fallingStep(host: SolverHost, builds: FallingBuilds): FallingStep {
  const pool = builds.pool;
  const module = isShared(host.memory) ? builds.shared : builds.plain;
  if (!module)
    throw new MargoError(
      'unsupported',
      pool
        ? 'Use shared world memory for falling-body helpers, or choose threads: 1.'
        : 'Shared falling solver Wasm is unavailable. Use plain world memory on this host.',
    );
  const stack = host.allocate('falling-kernel-stack', STACK_BYTES + 8, 'u8', 1);
  const threads = pool?.count ?? 1;
  const region = host.allocate('falling-native-job', JOB_BYTES + 8 * WORK_WORDS * threads, 'u8', 1);
  const job = region.byteOffset;
  const work = job + JOB_BYTES;
  const { exports } = new WebAssembly.Instance(module, { env: { memory: host.memory } });
  if (
    !(exports.__stack_pointer instanceof WebAssembly.Global) ||
    typeof exports.falling_step !== 'function' ||
    typeof exports.falling_thread_phase !== 'function'
  )
    throw new MargoError('version', 'Falling solver Wasm has incompatible exports. Run the falling kernel build.');
  exports.__stack_pointer.value = stackTop(stack);
  const serial = exports.falling_step as KernelExports['falling_step'];
  const phase = exports.falling_thread_phase as Stage;
  if (pool) {
    const control = host.allocate('falling-native-control', 4 * pool.controlWords, 'i32', 1);
    const stackTops = Array.from({ length: threads - 1 }, (_, i) =>
      stackTop(host.allocate(`falling-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
    );
    pool.init({ memory: host.memory, module, job, control: control.byteOffset, stackTops });
  }
  return {
    run(models, sections, air, state, next, count, dt) {
      if (!pool) return serial(models, sections, air, state, next, count, dt, work);
      const buffer = host.memory.buffer;
      new Uint32Array(buffer, job, 8).set([models, sections, air, state, next, work, count, 0]);
      new Float64Array(buffer, job + 32, 1)[0] = dt;
      return pool.phase(0, () => phase(job, 0, 0, threads));
    },
    workCounts() {
      const receipt = new Float64Array(host.memory.buffer, work, WORK_WORDS * threads);
      const totals = new Float64Array(WORK_WORDS);
      const workers = Array.from({ length: threads }, (_, worker) => {
        const at = worker * WORK_WORDS;
        for (let i = 0; i < WORK_WORDS; i++) totals[i]! += receipt[at + i]!;
        return workAt(receipt, at);
      });
      return { ...workAt(totals, 0), threads, workers };
    },
  };
}
