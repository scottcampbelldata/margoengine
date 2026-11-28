import { growthError } from './growth-errors.js';
import { growthControl as slots, type GrowthWorkerJob } from './growth-shadow-protocol.js';

const DEADLINE_MS = 10_000;

interface Helper {
  start(job: GrowthWorkerJob): void;
  observe(ready: () => void, fail: (cause: unknown) => void): void;
  unref(): void;
  close(): void;
}

async function spawn(): Promise<Helper> {
  const url = new URL(/* @vite-ignore */ './workers/growth-shadow.js?no-inline', import.meta.url);
  if (typeof Worker === 'function') {
    const worker = new Worker(url, { name: 'margoengine-growth-shadow' });
    const { port1, port2 } = new MessageChannel();
    return {
      start: (job) => port1.postMessage(job),
      observe(ready, fail) {
        port1.onmessage = ({ data }) => {
          if (data === 'ready') ready();
        };
        port1.onmessageerror = fail;
        worker.onerror = (event) => fail(event.error ?? event.message);
        worker.onmessageerror = fail;
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
  const { Worker: NodeWorker } = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
  url.search = '';
  const worker = new NodeWorker(url, { execArgv: [] });
  return {
    start: (job) => worker.postMessage(job),
    observe(ready, fail) {
      worker.on('message', (message: string) => {
        if (message === 'ready') ready();
      });
      worker.on('messageerror', fail);
      worker.on('error', fail);
      worker.on('exit', fail);
    },
    unref: () => worker.unref(),
    close: () => {
      void worker.terminate();
    },
  };
}

async function boot(helper: Helper, signal: AbortSignal): Promise<void> {
  let abort!: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else helper.observe(resolve, reject);
    });
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

type Binding = Omit<GrowthWorkerJob, 'stackTop' | 'part' | 'parts'>;

export class GrowthWorkerPool {
  private binding: Binding | undefined;
  private closed = false;
  readonly controlWords: number;

  constructor(private readonly helpers: readonly Helper[]) {
    this.controlWords = slots.status + helpers.length;
  }

  bind(binding: Binding, stackTops: readonly number[]): void {
    if (this.closed || this.binding)
      throw growthError('Load a fresh plant growth worker pool before binding this world.', 'state');
    this.binding = binding;
    try {
      for (const [i, helper] of this.helpers.entries())
        helper.start({ ...binding, stackTop: stackTops[i]!, part: i + 1, parts: this.helpers.length + 1 });
      this.wait(this.control(), slots.ready);
    } catch (cause) {
      this.close();
      throw cause;
    }
  }

  phase(caller: () => number): number {
    if (!this.binding || this.closed)
      throw growthError('Load working plant growth helpers, or choose threads: 1.', 'failed');
    try {
      const control = this.control();
      Atomics.store(control, slots.done, 0);
      Atomics.add(control, slots.generation, 1);
      Atomics.notify(control, slots.generation);
      const status = caller();
      this.wait(control, slots.done);
      if (status !== 0) return status;
      for (let i = 0; i < this.helpers.length; i++) {
        const result = Atomics.load(control, slots.status + i);
        if (result !== 0) return result;
      }
      return 0;
    } catch (cause) {
      this.close();
      throw cause;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.binding = undefined;
    for (const helper of this.helpers) helper.close();
  }

  private control(): Int32Array {
    const { memory, control } = this.binding!;
    return new Int32Array(memory.buffer, control, this.controlWords);
  }

  private wait(control: Int32Array, index: number): void {
    const limit = performance.now() + DEADLINE_MS;
    for (;;) {
      const count = Atomics.load(control, index);
      if (Atomics.load(control, slots.fault)) break;
      if (count === this.helpers.length) return;
      const remaining = limit - performance.now();
      if (remaining <= 0) break;
      Atomics.wait(control, index, count, remaining);
    }
    throw growthError(
      'Plant growth helpers stopped during shadow work. Reload the worker assets or choose threads: 1.',
      'failed',
    );
  }
}

export async function createGrowthWorkers(threads: 2 | 4, signal?: AbortSignal): Promise<GrowthWorkerPool> {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 0);
  } catch (cause) {
    throw growthError(
      'Run plant growth helpers in Node or an isolated browser worker, or choose threads: 1.',
      'unsupported',
      cause,
    );
  }
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const bootSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const helpers: Helper[] = [];
  try {
    for (let i = 1; i < threads; i++) {
      const helper = await spawn();
      helpers.push(helper);
      await boot(helper, bootSignal);
      helper.unref();
    }
    return new GrowthWorkerPool(helpers);
  } catch (cause) {
    for (const helper of helpers) helper.close();
    signal?.throwIfAborted();
    throw growthError(
      'Start plant growth helpers with the packaged worker asset or choose threads: 1.',
      'failed',
      cause,
    );
  }
}
