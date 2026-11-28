import { MargoError } from '@margoengine/math/errors';
import { canShareMemory, isShared } from '../world/memory.js';

/** Offsets in the shared i32 control region. Status has one word per worker, in partition order. */
export const TSUNAMI_THREAD_CONTROL = { generation: 0, stage: 1, ready: 2, done: 3, fault: 4, status: 5 } as const;

export interface TsunamiWorkerStart {
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly stackTop: number;
  readonly control: number;
  readonly job: number;
  readonly part: number;
  readonly parts: number;
}

interface ThreadBinding {
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly control: number;
  readonly job: number;
  readonly stackTops: readonly number[];
}

interface ThreadWorker {
  post(start: TsunamiWorkerStart): void;
  observe(ready: () => void, failed: (reason: unknown) => void): void;
  unref(): void;
  close(): void;
}

// Deadlines bound transport failures. Once a phase joins, its numerical result has no wall-clock input.
const DEADLINE_MS = 10_000;
const slots = TSUNAMI_THREAD_CONTROL;

function failedThreads(reason: string, cause?: unknown): MargoError {
  return Object.assign(
    new MargoError('failed', `Tsunami workers ${reason}. Load a new solver with working worker assets or threads: 1.`),
    { cause },
  );
}

function assertThreadEnvironment(): void {
  if (canShareMemory()) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 0);
      return;
    } catch {
      // Browser window agents cannot block. The world step must stay synchronous.
    }
  }
  throw new MargoError(
    'unsupported',
    'Tsunami threads need a blocking agent and shared memory. Use Node, a cross-origin-isolated browser worker, or threads: 1.',
  );
}

async function startWorker(): Promise<ThreadWorker> {
  const url = new URL(/* @vite-ignore */ './tsunami-thread.js', import.meta.url);
  if (typeof Worker === 'function') {
    const worker = new Worker(url, { type: 'module' });
    // Chromium can defer a nested Worker's startup message while its owner
    // waits. Connect a port during async boot so the later bind can wake it.
    const { port1, port2 } = new MessageChannel();
    return {
      post: (message) => port1.postMessage(message),
      observe(ready, failed) {
        port1.onmessage = ({ data }) => {
          if (data === 'ready') ready();
        };
        port1.onmessageerror = failed;
        worker.onerror = (event) => failed(event.error ?? event.message);
        worker.onmessageerror = failed;
        worker.postMessage(port2, [port2]);
      },
      unref() {},
      close() {
        port1.close();
        worker.terminate();
      },
    };
  }
  const name = 'node:worker_threads';
  const { Worker: NodeWorker } = (await import(/* @vite-ignore */ /* webpackIgnore: true */ name)) as {
    Worker: new (url: URL, options: { execArgv: string[] }) => {
      on(event: 'message' | 'messageerror' | 'error' | 'exit', listener: (value: unknown) => void): void;
      postMessage(message: TsunamiWorkerStart): void;
      unref(): void;
      terminate(): Promise<number>;
    };
  };
  // The entry is a packaged ES module. Do not inherit eval, test, or REPL flags from its host.
  const worker = new NodeWorker(url, { execArgv: [] });
  return {
    post: (message) => worker.postMessage(message),
    observe(ready, failed) {
      worker.on('message', (message) => {
        if (message === 'ready') ready();
      });
      worker.on('error', failed);
      worker.on('messageerror', failed);
      worker.on('exit', failed);
    },
    unref: () => worker.unref(),
    close: () => void worker.terminate(),
  };
}

async function waitForWorkerBoot(worker: ThreadWorker, signal: AbortSignal): Promise<void> {
  let abort!: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason);
      worker.observe(resolve, reject);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    worker.unref();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** The pool owns only workers. Its job, control and stacks are unsnapshotted regions owned by the solver. */
export class TsunamiThreads {
  readonly count: number;
  readonly controlWords: number;
  private binding?: ThreadBinding;
  private closed = false;

  constructor(private readonly workers: readonly ThreadWorker[]) {
    this.count = workers.length + 1;
    this.controlWords = slots.status + workers.length;
  }

  init(binding: ThreadBinding): void {
    if (this.closed || this.binding)
      throw new MargoError('state', 'Tsunami worker pool is already bound or closed. Load a new tsunami solver.');
    if (!isShared(binding.memory)) {
      this.close();
      throw new MargoError('unsupported', 'Tsunami threads need shared world memory. Use worldMemory(true) or threads: 1.');
    }
    if (binding.stackTops.length !== this.workers.length) {
      this.close();
      throw new MargoError('state', 'Give each tsunami worker its own stack top in the shared world arena.');
    }
    this.binding = binding;
    try {
      const control = this.control();
      control.fill(0);
      for (const [i, worker] of this.workers.entries()) {
        worker.post({
          module: binding.module,
          memory: binding.memory,
          control: binding.control,
          job: binding.job,
          stackTop: binding.stackTops[i]!,
          part: i + 1,
          parts: this.count,
        });
      }
      this.waitFor(control, slots.ready, 'did not initialize');
    } catch (cause) {
      this.close();
      if (cause instanceof MargoError) throw cause;
      throw failedThreads('did not initialize', cause);
    }
  }

  /** Run native parts concurrently and return a native status in canonical part order. */
  phase(stage: number, leader: () => number): number {
    if (this.closed || !this.binding)
      throw new MargoError('state', 'Tsunami workers are not available. Load a new solver with threads: 1 or working workers.');
    try {
      const control = this.control();
      Atomics.store(control, slots.done, 0);
      Atomics.store(control, slots.stage, stage);
      Atomics.add(control, slots.generation, 1);
      Atomics.notify(control, slots.generation);
      const status = leader();
      this.waitFor(control, slots.done, 'did not finish a flux phase');
      if (status !== 0) return status;
      for (let i = 0; i < this.workers.length; i++) {
        const workerStatus = Atomics.load(control, slots.status + i);
        if (workerStatus !== 0) return workerStatus;
      }
      return 0;
    } catch (cause) {
      this.close();
      if (cause instanceof MargoError) throw cause;
      throw failedThreads('trapped in a flux phase', cause);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const worker of this.workers) worker.close();
    this.binding = undefined;
  }

  private control(): Int32Array {
    const { memory, control } = this.binding!;
    return new Int32Array(memory.buffer, control, this.controlWords);
  }

  private waitFor(control: Int32Array, slot: number, failure: string): void {
    const limit = performance.now() + DEADLINE_MS;
    for (;;) {
      const seen = Atomics.load(control, slot);
      if (Atomics.load(control, slots.fault)) throw failedThreads('stopped during native work');
      if (seen === this.workers.length) return;
      const remaining = limit - performance.now();
      if (remaining <= 0) throw failedThreads(failure);
      Atomics.wait(control, slot, seen, remaining);
    }
  }
}

export async function createTsunamiThreads(threads: number, signal?: AbortSignal): Promise<TsunamiThreads> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(threads) || threads < 2)
    throw new MargoError('state', 'Give the tsunami worker pool a whole thread count of at least two.');
  assertThreadEnvironment();
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const boot = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const workers: ThreadWorker[] = [];
  try {
    for (let i = 1; i < threads; i++) {
      boot.throwIfAborted();
      const worker = await startWorker();
      workers.push(worker);
      await waitForWorkerBoot(worker, boot);
    }
    boot.throwIfAborted();
    return new TsunamiThreads(workers);
  } catch (cause) {
    for (const worker of workers) worker.close();
    signal?.throwIfAborted();
    throw failedThreads('could not start', cause);
  }
}
