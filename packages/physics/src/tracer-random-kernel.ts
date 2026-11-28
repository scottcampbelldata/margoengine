import { MargoError } from '@margoengine/math/errors';
import { createNativePhasePool, type NativePhasePool } from './native-phase-pool.js';
import { tracerError } from './tracer-errors.js';
import { MAX_MEMORY_PAGES } from './world/memory.js';

const PAGE = 65_536;
const JOB = 16;
const CONTROL = 80;
const WORK = 128;
const WORDS = 4;
const TWO_32 = 4_294_967_296;

/** Brownian random work done by one participant. */
export interface TracerRandomWorkerWork {
  readonly rows: number;
  /** Active parcel rows whose Philox rounds and final normal products used both SIMD lanes. */
  readonly pairedRows: number;
  /** One native SIMD round over two distinct parcel counters. */
  readonly philoxRoundPairs: number;
  readonly normalValues: number;
}

/** Accepted random work accumulated since reset, with the caller in worker slot zero. */
export interface TracerRandomWorkCounts extends TracerRandomWorkerWork {
  readonly batches: number;
  readonly threads: number;
  readonly workers: readonly TracerRandomWorkerWork[];
}

/** Synchronous batch of deterministic Box–Muller draws for tracer motion. */
export interface TracerRandomKernel {
  /** Three consecutive values per row in the supplied order. Each row is the parcel's unchanged unsigned slot ID. */
  normals(rows: Uint32Array, tick: number, seed: number, solver: number, out: Float64Array): void;
  workCounts(): TracerRandomWorkCounts;
  resetWork(): void;
  close(): void;
  [Symbol.dispose](): void;
}

function failure(message: string, cause?: unknown): MargoError {
  return Object.assign(tracerError(cause instanceof MargoError ? cause.code : 'failed', message), { cause });
}

async function loadModule(shared: boolean, signal?: AbortSignal): Promise<WebAssembly.Module> {
  const url = shared
    ? new URL(/* @vite-ignore */ './tracer-random-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './tracer-random-kernel.wasm?no-inline', import.meta.url);
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      return await WebAssembly.compile(await readFile(url, { signal }));
    }
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw failure(`The tracer random kernel returned HTTP ${response.status}. Serve its shipped Wasm asset.`);
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw failure('Load the matching tracer random asset in a Wasm SIMD runtime.', cause);
  }
}

function instantiate(module: WebAssembly.Module, threads: number) {
  try {
    const memory = new WebAssembly.Memory({ initial: threads + 1, maximum: MAX_MEMORY_PAGES, shared: threads > 1 });
    return { memory, exports: new WebAssembly.Instance(module, { env: { memory } }).exports };
  } catch (cause) {
    throw failure('Use matching tracer random assets in a compatible runtime, or choose threads: 1.', cause);
  }
}

function report(words: Float64Array, at: number): TracerRandomWorkerWork {
  return {
    rows: words[at]!,
    pairedRows: words[at + 1]!,
    philoxRoundPairs: words[at + 2]!,
    normalValues: words[at + 3]!,
  };
}

function isWord(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < TWO_32;
}

/** Load the optional native tracer random kernel. Use multiple participants in Node or an isolated browser worker. */
export async function loadTracerRandomKernel({
  threads = 1,
  signal,
}: {
  threads?: number;
  signal?: AbortSignal;
} = {}): Promise<TracerRandomKernel> {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw tracerError('state', 'Choose 1, 2 or 4 tracer random participants.');
  const shared = threads > 1;
  const module = await loadModule(shared, signal);
  signal?.throwIfAborted();
  const { memory, exports } = instantiate(module, threads);
  const { __stack_pointer: stack, __data_end: data, tracer_random_thread_phase: phase } = exports;
  if (
    !(stack instanceof WebAssembly.Global) ||
    !(data instanceof WebAssembly.Global) ||
    data.value !== 0 ||
    typeof phase !== 'function'
  )
    throw failure('Build the matching stateless tracer random assets with their native draw phase.');
  stack.value = 2 * PAGE;
  let pool: NativePhasePool | undefined;
  if (shared) {
    try {
      pool = await createNativePhasePool(threads, {
        subject: 'Tracer diffusion',
        phaseExport: 'tracer_random_thread_phase',
        phase: 'Brownian draws',
        signal,
      });
      pool.init({
        memory,
        module,
        job: JOB,
        control: CONTROL,
        stackTops: Array.from({ length: threads - 1 }, (_, i) => (i + 3) * PAGE),
      });
    } catch (cause) {
      pool?.close();
      signal?.throwIfAborted();
      throw failure('Run tracer helpers in Node or an isolated browser worker, or choose threads: 1.', cause);
    }
  }
  let closed = false;
  let batches = 0;
  const rowsAt = (threads + 1) * PAGE;
  const words = new Float64Array(WORDS * threads);
  const totals = new Float64Array(WORDS);
  function close() {
    if (closed) return;
    closed = true;
    pool?.close();
  }
  return {
    normals(rows, tick, seed, solver, out) {
      if (closed) throw tracerError('state', 'Load a new tracer random kernel after closing this one.');
      if (
        !(rows instanceof Uint32Array) ||
        !(out instanceof Float64Array) ||
        out.length !== 3 * rows.length ||
        !(Number.isSafeInteger(tick) && tick >= 0) ||
        !isWord(seed) ||
        !isWord(solver)
      )
        throw tracerError(
          'state',
          'Pass unsigned slot identifiers, three f64 words per slot, a non-negative integer tick and unsigned seed and solver words.',
        );
      if (rows.length === 0) return;
      const normalAt = rowsAt + Math.ceil(rows.byteLength / 8) * 8;
      const pages = Math.ceil((normalAt + out.byteLength) / PAGE);
      if (pages > MAX_MEMORY_PAGES)
        throw tracerError('state', 'Use fewer active parcel slots to fit native tracer random memory.');
      try {
        const grow = pages - memory.buffer.byteLength / PAGE;
        if (grow > 0) memory.grow(grow);
      } catch (cause) {
        throw failure('Use fewer active parcels to fit available tracer random memory.', cause);
      }
      const buffer = memory.buffer;
      new Uint32Array(buffer, rowsAt, rows.length).set(rows);
      new Uint32Array(buffer, JOB, 8).set([
        rowsAt,
        normalAt,
        WORK,
        rows.length,
        tick % TWO_32,
        Math.floor(tick / TWO_32),
        seed,
        solver,
      ]);
      const work = new Float64Array(buffer, WORK, words.length);
      let status: number;
      try {
        status = pool ? pool.phase(0, () => phase(JOB, 0, 0, threads)) : phase(JOB, 0, 0, 1);
      } catch (cause) {
        throw failure('Run matching tracer random workers and Wasm, or choose threads: 1.', cause);
      }
      if (status !== 0) throw failure('Use matching tracer random Wasm and staging buffers.');
      const pairs = Math.floor(rows.length / 2);
      for (let part = 0; part < threads; part++) {
        const receipt = report(work, part * WORDS);
        const count = Math.floor((pairs * (part + 1)) / threads) - Math.floor((pairs * part) / threads);
        const parcelCount = 2 * count + Number(part === threads - 1 && rows.length % 2 !== 0);
        if (
          receipt.rows !== parcelCount ||
          receipt.pairedRows !== 2 * count ||
          receipt.philoxRoundPairs !== 10 * count ||
          receipt.normalValues !== 3 * parcelCount
        )
          throw failure('Rebuild matching tracer random assets to obtain valid native work counts.');
      }
      const accepted = new Float64Array(buffer, normalAt, out.length);
      if (!accepted.every(Number.isFinite))
        throw failure('Use matching tracer random assets with finite Box–Muller output.');
      out.set(accepted);
      for (let i = 0; i < work.length; i++) {
        words[i]! += work[i]!;
        totals[i % WORDS]! += work[i]!;
      }
      batches++;
    },
    resetWork() {
      batches = 0;
      words.fill(0);
      totals.fill(0);
    },
    workCounts() {
      return {
        ...report(totals, 0),
        batches,
        threads,
        workers: Array.from({ length: threads }, (_, part) => report(words, part * WORDS)),
      };
    },
    close,
    [Symbol.dispose]: close,
  };
}
