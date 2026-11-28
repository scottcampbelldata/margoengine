import { MargoError } from '@margoengine/math/errors';
import {
  bindSurfaceEnergy,
  controlSlots as slots,
  INPUT_WORDS,
  MAX_PAGES,
  OUTPUT_WORDS,
  PAGE,
  type SurfaceEnergyWorkerStart,
  WORK_WORDS,
} from './surface-energy-native-core.js';
import { compileWasmAsset } from '../../shared/wasm-asset.js';

/** Work completed by one native participant in the latest accepted batch. */
export interface SurfaceEnergyWorkerWork {
  /** Number of surface patches solved. */
  readonly rows: number;
  /** Number of complete two-patch SIMD groups. */
  readonly pairs: number;
  /** Residual values evaluated, counting each active patch individually. */
  readonly balanceEvaluations: number;
  /** Residual evaluations with two active patches in the SIMD lanes. */
  readonly pairedBalanceEvaluations: number;
}

/** Ordered per-participant work and its deterministic batch totals. */
export interface SurfaceEnergyWorkCounts extends SurfaceEnergyWorkerWork {
  /** Native participant count, including the caller. */
  readonly threads: number;
  /** Participants in patch-range order, with the caller first. */
  readonly workers: readonly SurfaceEnergyWorkerWork[];
}

interface WorkerEndpoint {
  post(start: SurfaceEnergyWorkerStart): void;
  watch(reply: (value: string) => void, fail: (cause: unknown) => void): void;
  unref(): void;
  close(): void;
}

const WAIT_MS = 10_000;
const WORD = Float64Array.BYTES_PER_ELEMENT;

function failure(message: string, cause?: unknown): MargoError {
  return Object.assign(new MargoError('failed', message), { cause });
}

async function loadModule(shared: boolean, signal?: AbortSignal): Promise<WebAssembly.Module> {
  const url = shared
    ? new URL(/* @vite-ignore */ './surface-energy-kernel-shared.wasm?no-inline', import.meta.url)
    : new URL(/* @vite-ignore */ './surface-energy-kernel.wasm?no-inline', import.meta.url);
  return compileWasmAsset(
    url,
    signal,
    failure,
    (status) => `Surface energy kernel HTTP ${status}. Serve its bundled Wasm asset.`,
    'Run surface energy with Wasm SIMD support and its bundled kernel asset.',
  );
}

async function endpoint(): Promise<WorkerEndpoint> {
  const url = new URL(/* @vite-ignore */ './workers/surface-energy.js?no-inline', import.meta.url);
  if (typeof Worker === 'function') {
    const worker = new Worker(url);
    return {
      post: (start) => worker.postMessage(start),
      watch(reply, fail) {
        worker.onmessage = ({ data }) => reply(data);
        worker.onerror = (event) => fail(event.error ?? event.message);
        worker.onmessageerror = fail;
      },
      unref() {},
      close: () => worker.terminate(),
    };
  }
  url.search = '';
  const name = 'node:worker_threads';
  const { Worker: NodeWorker } = (await import(/* @vite-ignore */ /* webpackIgnore: true */ name)) as {
    Worker: new (
      url: URL,
      options: { execArgv: string[] },
    ) => {
      postMessage(start: SurfaceEnergyWorkerStart): void;
      on(event: 'message', handler: (value: string) => void): void;
      on(event: 'error' | 'messageerror' | 'exit', handler: (cause: unknown) => void): void;
      unref(): void;
      terminate(): Promise<number>;
    };
  };
  const worker = new NodeWorker(url, { execArgv: [] });
  return {
    post: (start) => worker.postMessage(start),
    watch(reply, fail) {
      worker.on('message', reply);
      worker.on('error', fail);
      worker.on('messageerror', fail);
      worker.on('exit', fail);
    },
    unref: () => worker.unref(),
    close: () => void worker.terminate(),
  };
}

function assertThreadEnvironment(): void {
  if (typeof SharedArrayBuffer === 'function') {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 0);
      return;
    } catch {
      // A browser window cannot synchronously join native helper work.
    }
  }
  throw new MargoError(
    'unsupported',
    'Run threaded surface energy in Node or a cross-origin-isolated browser worker, or choose threads: 1.',
  );
}

async function startWorker(
  worker: WorkerEndpoint,
  start: SurfaceEnergyWorkerStart,
  signal: AbortSignal,
  recordFault: (cause: unknown) => void,
): Promise<void> {
  let abort!: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      worker.watch(
        (value) => {
          if (value === 'ready') resolve();
          else reject(failure('Start the matching surface-energy worker assets or choose threads: 1.'));
        },
        (cause) => {
          recordFault(cause);
          reject(cause);
        },
      );
      worker.post(start);
    });
    worker.unref();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function loadSurfaceEnergyKernel({
  threads = 1,
  signal,
}: {
  threads?: number;
  signal?: AbortSignal;
} = {}) {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4)
    throw new MargoError('state', 'Use 1, 2 or 4 native surface-energy participants.');
  const shared = threads > 1;
  if (shared) assertThreadEnvironment();
  const module = await loadModule(shared, signal);
  signal?.throwIfAborted();
  const pages = threads + 1;
  const memory = new WebAssembly.Memory({ initial: pages, maximum: MAX_PAGES, shared });
  const control = new Int32Array(memory.buffer, 0, slots.status + threads - 1);
  const start = { module, memory, part: 0, parts: threads };
  const helpers: WorkerEndpoint[] = [];
  let closed = false;
  let workerFailure: unknown;
  function close() {
    if (closed) return;
    closed = true;
    for (const helper of helpers) helper.close();
  }
  const markFault = (cause: unknown) => {
    if (closed) return;
    workerFailure = cause;
    Atomics.store(control, slots.fault, 1);
    Atomics.notify(control, slots.done);
  };
  const deadline = AbortSignal.timeout(WAIT_MS);
  const boot = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let apply: ReturnType<typeof bindSurfaceEnergy>;
  try {
    apply = bindSurfaceEnergy(start);
    for (let part = 1; part < threads; part++) {
      boot.throwIfAborted();
      const helper = await endpoint();
      helpers.push(helper);
      await startWorker(helper, { ...start, part }, boot, markFault);
    }
    boot.throwIfAborted();
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw failure('Start the bundled surface-energy kernel and helpers, or use threads: 1.', cause);
  }

  return {
    step(input: Float64Array, output: Float64Array): SurfaceEnergyWorkCounts {
      if (closed) throw new MargoError('state', 'Use a new surface-energy kernel after disposal.');
      const rows = input.length / INPUT_WORDS;
      if (!Number.isInteger(rows) || rows < 1 || output.length !== rows * OUTPUT_WORDS)
        throw new MargoError('state', 'Provide complete input and output rows for the surface-energy batch.');
      const inAt = pages * PAGE;
      const outAt = inAt + input.byteLength;
      const receiptAt = outAt + output.byteLength;
      const need = Math.ceil((receiptAt + WORK_WORDS * WORD * threads) / PAGE);
      if (need > MAX_PAGES)
        throw new MargoError('state', 'Use fewer surface-energy patches so their native work fits Wasm memory.');
      try {
        const grow = need - memory.buffer.byteLength / PAGE;
        if (grow > 0) memory.grow(grow);
      } catch (cause) {
        throw failure('Allocate a smaller surface-energy grid to fit the available Wasm memory.', cause);
      }
      const buffer = memory.buffer;
      new Float64Array(buffer, inAt, input.length).set(input);
      let status: number;
      try {
        if (shared) {
          Atomics.store(control, slots.input, inAt);
          Atomics.store(control, slots.output, outAt);
          Atomics.store(control, slots.receipts, receiptAt);
          Atomics.store(control, slots.rows, rows);
          Atomics.store(control, slots.done, 0);
          Atomics.add(control, slots.generation, 1);
          Atomics.notify(control, slots.generation);
        }
        status = apply(inAt, outAt, receiptAt, rows, 0, threads);
        if (shared) {
          const expires = performance.now() + WAIT_MS;
          for (;;) {
            const done = Atomics.load(control, slots.done);
            if (Atomics.load(control, slots.fault)) throw workerFailure ?? new Error('Native worker trapped.');
            if (done === helpers.length) break;
            const remaining = expires - performance.now();
            if (remaining <= 0)
              throw new MargoError(
                'timeout',
                'Native helpers timed out after 10 s; check that the worker and Wasm assets are served.',
              );
            Atomics.wait(control, slots.done, done, remaining);
          }
          for (let part = 0; part < helpers.length; part++) status ||= Atomics.load(control, slots.status + part);
        }
      } catch (cause) {
        close();
        throw failure('Run surface energy with its matching worker assets, or choose threads: 1.', cause);
      }
      if (status !== 0)
        throw new MargoError(
          'state',
          'Surface energy exceeds the finite implicit balance range. Reduce forcing or use finite SI material properties.',
        );
      const data = new Float64Array(buffer, receiptAt, WORK_WORDS * threads);
      const pairs = Math.floor(rows / 2);
      let balanceEvaluations = 0;
      let pairedBalanceEvaluations = 0;
      const workers = Array.from({ length: threads }, (_, part): SurfaceEnergyWorkerWork => {
        const at = part * WORK_WORDS;
        const paired = data[at + 1]!;
        const assigned = Math.floor(((part + 1) * pairs) / threads) - Math.floor((part * pairs) / threads);
        const visited = data[at]!;
        const evaluations = data[at + 2]!;
        const simd = data[at + 3]!;
        if (
          paired !== assigned ||
          visited !== 2 * assigned + (part === threads - 1 ? rows % 2 : 0) ||
          !Number.isSafeInteger(evaluations) ||
          !Number.isSafeInteger(simd) ||
          simd < 0 ||
          evaluations < 2 * simd
        )
          throw failure('Surface energy worker receipts were invalid. Rebuild the matching kernel asset.');
        balanceEvaluations += evaluations;
        pairedBalanceEvaluations += simd;
        return { rows: visited, pairs: paired, balanceEvaluations: evaluations, pairedBalanceEvaluations: simd };
      });
      output.set(new Float64Array(buffer, outAt, output.length));
      return { threads, rows, pairs, balanceEvaluations, pairedBalanceEvaluations, workers };
    },
    close,
  };
}
