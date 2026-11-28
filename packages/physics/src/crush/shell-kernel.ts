import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { canShareMemory, isShared, MAX_MEMORY_PAGES, STACK_BYTES } from '../world/memory.js';
import type { Region, SolverHost } from '../world/solver.js';
import { crushError } from './errors.js';

const JOB_BYTES = 24;
const FACE_BYTES = 176;
const WORK_WORDS = 5;

/** Native per-participant membrane evaluation during the accepted interval. */
export interface ShellNativeWorkerWork {
  readonly forceEvaluations: number;
  readonly faces: number;
  /** Face evaluations whose deformation gradients and Green strains used both SIMD lanes. */
  readonly pairedFaces: number;
  /** Inelastic returns that increased the face's equivalent plastic strain. */
  readonly plasticReturns: number;
  readonly pressureFaces: number;
}

/** Independent membrane work with the caller in slot zero. */
export interface ShellNativeWorkCounts extends ShellNativeWorkerWork {
  readonly threads: number;
  readonly workers: readonly ShellNativeWorkerWork[];
}

export interface ShellBuilds {
  readonly plain?: WebAssembly.Module;
  readonly shared?: WebAssembly.Module;
  readonly threaded?: WebAssembly.Module;
  readonly pool?: NativePhasePool;
  [Symbol.dispose](): void;
}

async function compile(url: URL, signal: AbortSignal | undefined): Promise<WebAssembly.Module> {
  try {
    signal?.throwIfAborted();
    if (url.protocol === 'file:') {
      url.search = '';
      const specifier = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier);
      return await WebAssembly.compile(await readFile(url, { signal }));
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw crushError('failed', `Crush shell kernel returned HTTP ${response.status}. Serve its matching Wasm asset.`);
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(crushError('failed', 'Load the matching crush shell asset in a Wasm SIMD runtime.'), { cause });
  }
}

export async function loadShell(signal?: AbortSignal, threads = 1): Promise<ShellBuilds> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw crushError('state', 'Choose 1, 2 or 4 crush shell participants.');
  if (threads > 1 && !canShareMemory())
    throw crushError('unsupported', 'Use Node or an isolated browser worker with shared memory, or choose threads: 1.');
  const [plain, shared, threaded] = await Promise.all([
    threads === 1
      ? compile(new URL(/* @vite-ignore */ './crush-shell-kernel.wasm?no-inline', import.meta.url), signal)
      : undefined,
    canShareMemory()
      ? compile(new URL(/* @vite-ignore */ './crush-shell-kernel-shared.wasm?no-inline', import.meta.url), signal)
      : undefined,
    threads > 1
      ? compile(new URL(/* @vite-ignore */ './crush-shell-kernel-threaded.wasm?no-inline', import.meta.url), signal)
      : undefined,
  ]);
  let pool: NativePhasePool | undefined;
  function dispose() {
    signal?.removeEventListener('abort', dispose);
    pool?.close();
  }
  signal?.throwIfAborted();
  try {
    if (threaded) {
      pool = await createNativePhasePool(threads, {
        subject: 'Crush shell',
        phaseExport: 'crush_shell_thread_phase',
        phase: 'membrane evaluation',
        signal,
      });
      signal?.addEventListener('abort', dispose, { once: true });
      signal?.throwIfAborted();
    }
    return { plain, shared, threaded, pool, [Symbol.dispose]: dispose };
  } catch (cause) {
    dispose();
    signal?.throwIfAborted();
    throw Object.assign(
      crushError('failed', 'Start crush shell workers in Node or an isolated browser worker, or choose threads: 1.'),
      { cause },
    );
  }
}

interface ShellExports {
  crush_shell_advance(descriptor: number, seconds: number, count: number, work: number): number;
  workCounts(): ShellNativeWorkCounts;
  [Symbol.dispose](): void;
}

type Phase = (job: number, stage: number, part: number, parts: number) => number;
type Advance = (...args: [...Parameters<ShellExports['crush_shell_advance']>, number]) => number;

function report(words: Float64Array, at: number): ShellNativeWorkerWork {
  return {
    forceEvaluations: words[at]!,
    faces: words[at + 1]!,
    pairedFaces: words[at + 2]!,
    plasticReturns: words[at + 3]!,
    pressureFaces: words[at + 4]!,
  };
}

function combined(words: Float64Array, threads: number): ShellNativeWorkCounts {
  const total = new Float64Array(WORK_WORDS);
  total[0] = words[0]!;
  for (let i = 0; i < threads; i++)
    for (let field = 1; field < WORK_WORDS; field++) total[field]! += words[i * WORK_WORDS + field]!;
  return {
    ...report(total, 0),
    threads,
    workers: Array.from({ length: threads }, (_, i) => report(words, i * WORK_WORDS)),
  };
}

function stackTop(stack: Region): number {
  return Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
}

export function instanceFor(
  host: SolverHost,
  builds: ShellBuilds,
  faces: number,
): { kernel: ShellExports; stack: Region } {
  try {
    const shared = isShared(host.memory);
    const pool = builds.pool;
    if (pool && !shared)
      throw crushError('unsupported', 'Use shared world memory for crush shell workers, or choose threads: 1.');
    const module = builds.threaded ?? (shared ? builds.shared : builds.plain);
    if (!module)
      throw crushError('unsupported', 'Load the matching shared crush shell asset, or create a plain-memory world.');
    const faceBytes = FACE_BYTES * faces;
    if (pool && (!Number.isSafeInteger(faceBytes) || faceBytes > MAX_MEMORY_PAGES * 65_536))
      throw crushError('state', 'Use fewer crush shell faces to fit native worker scratch into the world.');
    const threads = pool?.count ?? 1;
    const stack = host.allocate('shell-stack', STACK_BYTES + 8, 'u8', 1);
    const work = host.allocate('shell-native-job', JOB_BYTES + WORK_WORDS * 8 * threads, 'u8', 1);
    const output = pool && host.allocate('shell-native-contributions', faceBytes, 'u8', 1);
    const job = work.byteOffset;
    const receipts = job + JOB_BYTES;
    let phase: Phase | undefined;
    const { exports } = new WebAssembly.Instance(module, {
      env: {
        memory: host.memory,
        crush_shell_join(): number {
          if (!pool || !phase)
            throw crushError('failed', 'Bind the shell helper workers before advancing the membrane.');
          const evaluate = phase;
          return pool.phase(0, () => evaluate(job, 0, 0, threads));
        },
      },
    });
    const pointer = exports.__stack_pointer;
    const raw = exports.crush_shell_advance;
    const phaseExport = exports.crush_shell_thread_phase;
    if (!(pointer instanceof WebAssembly.Global) || typeof raw !== 'function' || typeof phaseExport !== 'function')
      throw crushError('failed', 'Rebuild matching crush shell assets with the stack, interval and membrane exports.');
    pointer.value = stackTop(stack);
    phase = phaseExport as Phase;
    const advance = raw as Advance;
    if (pool) {
      const module = builds.shared;
      if (!module) throw crushError('failed', 'Serve the matching shared crush shell worker asset.');
      const control = host.allocate('shell-native-control', 4 * pool.controlWords, 'i32', 1);
      const stacks = Array.from({ length: threads - 1 }, (_, i) =>
        stackTop(host.allocate(`shell-helper-stack-${i}`, STACK_BYTES + 8, 'u8', 1)),
      );
      pool.init({ memory: host.memory, module, job, control: control.byteOffset, stackTops: stacks });
    }
    const accepted = new Float64Array(WORK_WORDS * threads);
    return {
      stack,
      kernel: {
        crush_shell_advance(...args) {
          const buffer = host.memory.buffer;
          const counters = new Float64Array(buffer, receipts, accepted.length);
          counters.fill(0);
          const settings = new Uint32Array(buffer, job, JOB_BYTES / 4);
          settings[3] = output?.byteOffset ?? 0;
          settings[4] = receipts;
          settings[5] = threads;
          let status: number;
          try {
            status = advance(...args, job);
          } catch (cause) {
            throw Object.assign(
              crushError('failed', 'Run matching crush shell workers and Wasm, or choose threads: 1.'),
              { cause },
            );
          }
          if (status === 1) accepted.set(counters);
          return status;
        },
        workCounts: () => combined(accepted, threads),
        [Symbol.dispose]: () => builds[Symbol.dispose](),
      },
    };
  } catch (cause) {
    builds[Symbol.dispose]();
    if (cause instanceof MargoError && cause.message.endsWith('#ductile-crush')) throw cause;
    throw Object.assign(
      crushError('failed', 'Bind matching shell assets and geometry to the world, or choose threads: 1.'),
      { cause },
    );
  }
}
