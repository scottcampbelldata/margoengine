import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from '../native-phase-pool.js';
import { MAX_MEMORY_PAGES } from '../world/memory.js';
import { rogueError } from './errors.js';

const PAGE = 65_536;
const JOB = 16;
const CONTROL = 96;
const ANSWER = 176;
const WORK = 208;
const TILE_PAIRS = 262_144;
const WORK_WORDS = 3;

/** Actual upper-triangle evaluations by one native participant. */
export interface RoguePairWorkerWork {
  readonly tiles: number;
  readonly pairs: number;
  /** Pair evaluations performed in an f64x2 lane. A scalar tail is excluded. */
  readonly pairedPairs: number;
}

/** Native work for the last accepted second-order query, with the caller in slot zero. */
export interface RoguePairWorkCounts extends RoguePairWorkerWork {
  readonly threads: number;
  readonly workers: readonly RoguePairWorkerWork[];
}

type Envelope = readonly [Float64Array, Float64Array, Float64Array, Float64Array];

export interface RoguePairKernel {
  evaluate(
    cr: Float64Array,
    ci: Float64Array,
    slopes: boolean,
    envelope?: Envelope,
  ): readonly [height: number, slopeX: number, slopeZ: number];
  workCounts(): RoguePairWorkCounts;
  [Symbol.dispose](): void;
}

function failed(message: string, cause?: unknown): MargoError {
  return Object.assign(rogueError('failed', message), { cause });
}

async function loadModule(shared: boolean, signal?: AbortSignal): Promise<WebAssembly.Module> {
  const url = shared
    ? new URL(/* @vite-ignore */ './rogue-pair-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './rogue-pair-kernel.wasm?no-inline', import.meta.url);
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      return await WebAssembly.compile(await readFile(url, { signal }));
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw failed(`The wave-pair asset returned HTTP ${response.status}. Serve the shipped Wasm file.`);
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw failed('Load the matching wave-pair asset in a Wasm SIMD runtime, or use the scalar sea constructor.', cause);
  }
}

function report(work: Uint32Array, part: number): RoguePairWorkerWork {
  const at = part * WORK_WORDS;
  return { tiles: work[at]!, pairs: work[at + 1]!, pairedPairs: work[at + 2]! };
}

export async function loadRoguePairs(
  kx: Float64Array,
  kz: Float64Array,
  bp: Float64Array,
  bm: Float64Array,
  { threads = 1, signal }: { threads?: number; signal?: AbortSignal } = {},
): Promise<RoguePairKernel> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw rogueError('unsupported', 'Choose 1, 2 or 4 wave-pair participants.');
  const n = kx.length;
  const total = (n * (n + 1)) / 2;
  if (n === 0 || kz.length !== n || bp.length !== total || bm.length !== total)
    throw rogueError(
      'unsupported',
      'Give one wavevector per component and its canonical upper-triangle pair coefficients.',
    );
  const limit = Math.min(total, TILE_PAIRS);
  const basisAt = (threads + 1) * PAGE;
  const coefficientsAt = basisAt + 8 * n * Float64Array.BYTES_PER_ELEMENT;
  const tileAt = coefficientsAt + 2 * total * Float64Array.BYTES_PER_ELEMENT;
  const pages = Math.ceil((tileAt + 3 * limit * Float64Array.BYTES_PER_ELEMENT) / PAGE);
  if (pages > MAX_MEMORY_PAGES)
    throw rogueError('unsupported', 'Use fewer wave components to fit the available Wasm address space.');
  const shared = threads > 1;
  const module = await loadModule(shared, signal);
  signal?.throwIfAborted();
  let memory: WebAssembly.Memory;
  let exports: WebAssembly.Exports;
  try {
    memory = new WebAssembly.Memory({ initial: pages, maximum: MAX_MEMORY_PAGES, shared });
    exports = new WebAssembly.Instance(module, { env: { memory } }).exports;
  } catch (cause) {
    throw failed(
      'Use fewer wave components and run helpers in Node or an isolated browser worker, or choose threads: 1.',
      cause,
    );
  }
  const { __stack_pointer: stack, rogue_pair_thread_phase: phase, rogue_pair_reduce: reduce } = exports;
  if (!(stack instanceof WebAssembly.Global) || typeof phase !== 'function' || typeof reduce !== 'function')
    throw failed('Serve the matching stateless wave-pair assets with their evaluation and ordered-fold exports.');
  stack.value = 2 * PAGE;
  const basis = new Float64Array(memory.buffer, basisAt, 8 * n);
  const coefficients = new Float64Array(memory.buffer, coefficientsAt, 2 * total);
  const job = new Uint32Array(memory.buffer, JOB, 10);
  const work = new Uint32Array(memory.buffer, WORK, WORK_WORDS * threads);
  const answer = new Float64Array(memory.buffer, ANSWER, 3);
  basis.set(kx);
  basis.set(kz, n);
  coefficients.set(bp);
  coefficients.set(bm, total);
  job.set([basisAt, coefficientsAt, tileAt, ANSWER, WORK, n, total]);
  let pool: NativePhasePool | undefined;
  let closed = false;
  const accepted = new Uint32Array(work.length);
  let tiles = 0;
  function close() {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', close);
    pool?.close();
  }
  try {
    if (shared) {
      pool = await createNativePhasePool(threads, {
        subject: 'Wave pairs',
        phaseExport: 'rogue_pair_thread_phase',
        phase: 'second-order interactions',
        signal,
      });
      pool.init({
        memory,
        module,
        job: JOB,
        control: CONTROL,
        stackTops: Array.from({ length: threads - 1 }, (_, i) => (i + 3) * PAGE),
      });
    }
    signal?.addEventListener('abort', close, { once: true });
    signal?.throwIfAborted();
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw failed('Start wave-pair helpers in Node or an isolated browser worker, or choose threads: 1.', cause);
  }
  return {
    evaluate(cr, ci, slopes, envelope) {
      if (closed) throw rogueError('unsupported', 'Load a new wave-pair evaluator after closing this one.');
      if (cr.length !== n || ci.length !== n || (envelope && envelope.some((row) => row.length !== n)))
        throw rogueError('unsupported', 'Give one phase and envelope derivative per initialized wave component.');
      basis.set(cr, 2 * n);
      basis.set(ci, 3 * n);
      if (slopes && envelope) for (const [axis, row] of envelope.entries()) basis.set(row, (4 + axis) * n);
      job[9] = slopes ? (envelope ? 2 : 1) : 0;
      work.fill(0);
      answer.fill(0);
      let count = 0;
      try {
        for (let start = 0; start < total; start += limit) {
          job[7] = start;
          job[8] = Math.min(limit, total - start);
          const leader = () => phase(JOB, 0, 0, threads) as number;
          if ((pool ? pool.phase(0, leader) : leader()) !== 0 || reduce(JOB) !== 0)
            throw failed('Use matching wave-pair coefficient and scratch layouts.');
          count++;
        }
      } catch (cause) {
        if (cause instanceof MargoError && cause.message.endsWith('#nonlinear-sea')) throw cause;
        throw failed('Use matching wave-pair workers and Wasm, or choose threads: 1.', cause);
      }
      const height = answer[0]!;
      const dx = answer[1]!;
      const dz = answer[2]!;
      if (!(Number.isFinite(height) && Number.isFinite(dx) && Number.isFinite(dz)))
        throw failed('Reduce the energy or narrow the wave spectrum to keep the second-order surface finite.');
      accepted.set(work);
      tiles = count;
      return [height, dx, dz];
    },
    workCounts() {
      const workers = Array.from({ length: threads }, (_, part) => report(accepted, part));
      return {
        threads,
        tiles,
        pairs: workers.reduce((sum, worker) => sum + worker.pairs, 0),
        pairedPairs: workers.reduce((sum, worker) => sum + worker.pairedPairs, 0),
        workers,
      };
    },
    [Symbol.dispose]: close,
  };
}
